/**
 * Patient-wiki service (server-only).
 *
 * Bridges the persisted per-day chat history and the per-patient workspace:
 *   1. Render a day's conversation to a read-only `raw/conversations/<day>.md`.
 *   2. Run the nightly profiling pipeline through the agent (patient-wiki
 *      skill Ingest flow: observations append + profile rebuild).
 *   3. Ingest an arbitrary raw file into the patient wiki.
 *
 * The agent owns all writes under `wiki/`; `raw/` is write-denied by the
 * engine's scope permissions.
 */

import { getDayMessages, type HistoryRow } from "@/services/chat-history";
import { writeRawFile, readRawFile, readWorkspaceFile, writeWikiFile } from "@/services/workspace";
import { shanghaiDay, formatShanghaiDateTime } from "@/lib/time";
import { callAgent } from "@/services/ai";
import { writeAudit } from "@/services/xiaozhi/audit";

export interface RenderResult {
  date: string;
  messageCount: number;
  virtualPath: string;
}

export interface NightlyResult {
  deviceId: string;
  date: string;
  messageCount: number;
  reply: string;
  changedFiles: string[];
  durationMs: number;
  skipped: boolean;
}

export interface IngestResult {
  deviceId: string;
  rawPath: string;
  reply: string;
  changedFiles: string[];
  durationMs: number;
}

/** Per-device lock so two nightly runs cannot overlap. */
const nightlyLocks = new Map<string, boolean>();

/** Read the day's chat history from the DB and write it as a read-only raw conversation file. */
export async function renderConversationsToRaw(
  deviceId: string,
  date?: string,
): Promise<RenderResult> {
  const day = date ?? shanghaiDay();
  const rows = await getDayMessages(deviceId, day);
  const markdown = renderConversationMarkdown(deviceId, day, rows);
  const written = await writeRawFile(deviceId, `conversations/${day}.md`, markdown);
  return {
    date: day,
    messageCount: rows.length,
    virtualPath: written.virtualPath,
  };
}

/** Nightly pipeline: render today's conversation → run the patient-wiki Ingest via the agent. */
export async function runNightlyProfile(
  deviceId: string,
  date?: string,
): Promise<NightlyResult> {
  const day = date ?? shanghaiDay();

  if (nightlyLocks.get(deviceId)) {
    throw new Error(`nightly already running for ${deviceId}`);
  }
  nightlyLocks.set(deviceId, true);

  const startedAt = Date.now();
  try {
    const rendered = await renderConversationsToRaw(deviceId, day);

    if (rendered.messageCount === 0) {
      return {
        deviceId,
        date: day,
        messageCount: 0,
        reply: "当日无对话记录，跳过画像。",
        changedFiles: [],
        durationMs: Date.now() - startedAt,
        skipped: true,
      };
    }

    const opts = { scope: deviceId, temperature: 0.2, maxTokens: 4096 };
    const conversation = await readRawFile(deviceId, `conversations/${day}.md`);
    const observations = await readOptionalWikiFile(deviceId, "observations.md");
    const caseMd = await readOptionalWikiFile(deviceId, "case.md");
    const timeline = await readOptionalWikiFile(deviceId, "timeline.md");

    const batch = await callAgent(
      buildNightlyBatchDirective(day, conversation, observations, timeline),
      opts,
    );
    const parsed = parseDelimitedFiles(batch);
    const obsAppend = stripCodeFence(parsed["observations"] ?? "");
    const timelineAppend = stripCodeFence(parsed["timeline"] ?? "");
    const summary = stripCodeFence(parsed["summary"] ?? "");

    const changedFiles: string[] = [];
    if (obsAppend) {
      await appendWikiFile(deviceId, "observations.md", obsAppend);
      changedFiles.push("observations.md");
    }
    if (timelineAppend) {
      await appendWikiFile(deviceId, "timeline.md", timelineAppend);
      changedFiles.push("timeline.md");
    }
    if (summary) {
      await writeWikiFile(deviceId, `conversations/${day}.md`, `${summary}\n`);
      changedFiles.push(`conversations/${day}.md`);
    }

    const updatedObservations = await readOptionalWikiFile(deviceId, "observations.md");
    const profile = stripCodeFence(
      await callAgent(buildProfileDirective(updatedObservations, caseMd), opts),
    );
    if (profile) {
      await writeWikiFile(deviceId, "profile.md", `${profile}\n`);
      changedFiles.push("profile.md");
    }

    await appendWikiLog(deviceId, `## [${day}] nightly | 画像更新`);
    changedFiles.push("log.md");

    const reply = `夜间画像完成（${rendered.messageCount} 条对话）。更新：${changedFiles.join(", ")}。`;
    const durationMs = Date.now() - startedAt;

    try {
      await writeAudit({
        actor: "system",
        actorId: "nightly",
        action: "patient.nightly",
        target: `device:${deviceId}`,
        payload: { date: day, messageCount: rendered.messageCount, durationMs },
      });
    } catch (err) {
      console.error(`[patient-wiki] audit failed for ${deviceId}:`, err);
    }

    return {
      deviceId,
      date: day,
      messageCount: rendered.messageCount,
      reply,
      changedFiles,
      durationMs,
      skipped: false,
    };
  } finally {
    nightlyLocks.delete(deviceId);
  }
}

/** Ingest a specific raw file into the patient wiki. */
export async function ingestRawFile(
  deviceId: string,
  rawPath: string,
): Promise<IngestResult> {
  const normalized = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!normalized) {
    throw new Error("rawPath must be a non-empty string");
  }
  if (normalized.includes("..")) {
    throw new Error(`Invalid rawPath: ${rawPath}`);
  }

  const startedAt = Date.now();
  const { reply, changedFiles } = await runIngestDeterministic(deviceId, normalized);
  return {
    deviceId,
    rawPath: normalized,
    reply,
    changedFiles,
    durationMs: Date.now() - startedAt,
  };
}

const INGEST_FILES = ["case.md", "timeline.md", "index.md"];

async function runIngestDeterministic(
  deviceId: string,
  rawPath: string,
): Promise<{ reply: string; changedFiles: string[] }> {
  const opts = { scope: deviceId, temperature: 0.2, maxTokens: 4096 };
  const rawContent = await readWorkspaceFile(deviceId, rawPath);

  const existing: Record<string, string> = {};
  for (const name of INGEST_FILES) {
    existing[name] = await readOptionalWikiFile(deviceId, name);
  }

  const generated = await generateWikiFiles(deviceId, rawPath, rawContent, existing, opts);

  const changed: string[] = [];
  for (const name of INGEST_FILES) {
    const content = (generated[name] ?? "").trim();
    if (!content) continue;
    await writeWikiFile(deviceId, name, `${content}\n`);
    changed.push(name);
  }

  await appendWikiLog(deviceId, `## [${shanghaiDay()}] ingest | ${rawPath}`);
  changed.push("log.md");

  return {
    reply: `已摄入 ${rawPath}。更新文件：${changed.join(", ")}。`,
    changedFiles: changed,
  };
}

async function generateWikiFiles(
  deviceId: string,
  rawPath: string,
  rawContent: string,
  existing: Record<string, string>,
  opts: { scope: string; temperature: number; maxTokens: number },
): Promise<Record<string, string>> {
  const output = await callAgent(
    buildIngestDirective(rawPath, rawContent, existing),
    opts,
  );
  const parsed = parseDelimitedFiles(output);

  for (const name of INGEST_FILES) {
    if (parsed[name]?.trim()) continue;
    const single = await callAgent(
      buildSingleFileDirective(name, rawPath, rawContent, existing[name] ?? ""),
      opts,
    );
    parsed[name] = stripCodeFence(single);
  }

  return parsed;
}

function parseDelimitedFiles(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /===FILE:\s*([^\n=]+?)\s*===\s*\n([\s\S]*?)(?=\n===FILE:|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out[match[1].trim()] = match[2].trim();
  }
  return out;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

async function readOptionalWikiFile(deviceId: string, name: string): Promise<string> {
  try {
    return await readWorkspaceFile(deviceId, name);
  } catch {
    return "";
  }
}

async function appendWikiLog(deviceId: string, entry: string): Promise<void> {
  const current = await readOptionalWikiFile(deviceId, "log.md");
  const base = current.trimEnd() || "# Wiki Change Log";
  await writeWikiFile(deviceId, "log.md", `${base}\n\n${entry}\n`);
}

async function appendWikiFile(deviceId: string, name: string, block: string): Promise<void> {
  const current = await readOptionalWikiFile(deviceId, name);
  const base = current.trimEnd();
  await writeWikiFile(deviceId, name, `${base}\n\n${block.trim()}\n`);
}

function renderConversationMarkdown(
  deviceId: string,
  day: string,
  rows: HistoryRow[],
): string {
  const lines: string[] = [
    `# 患者对话 · ${day}`,
    "",
    `- 设备: ${deviceId}`,
    `- 消息数: ${rows.length}`,
    `- 来源: 系统数据库（只读原文，禁止修改）`,
    "",
    "---",
    "",
  ];

  if (rows.length === 0) {
    lines.push("（当日无对话记录）");
  } else {
    for (const row of rows) {
      const hhmm = formatShanghaiDateTime(row.createdAt).slice(11, 16);
      lines.push(`[${hhmm}] ${row.role}: ${row.content}`);
    }
  }

  return lines.join("\n") + "\n";
}

function buildNightlyBatchDirective(
  day: string,
  conversation: string,
  observations: string,
  timeline: string,
): string {
  return [
    "你是本患者工作区的知识库维护者，严格遵循 patient-wiki 技能（/skills/patient-wiki/SKILL.md）。",
    `请根据 ${day} 当天的患者对话，生成三类内容：新的观察条目、时间线补充、当日对话摘要。`,
    "",
    "要求：",
    "- observations：从对话中提取**新增**观察条目，每条格式 `### [obs:<日期>-<序号>]`，包含 类别 / 观察 / 原话(逐字) / 出处 / 置信；append-only，不要重复已有条目。",
    "- timeline：如对话中有客观事件，追加时间线条目；没有就留空。",
    "- summary：当日对话分析摘要（Markdown）；若出现急症信号（胸痛、呼吸困难、意识改变、晕厥、大出血、剧烈头痛、自杀/自伤意念、高热惊厥等），必须在摘要顶部显著提示「⚠️ 请立即就医 / 拨打 120」。",
    "- 只写非临床维度；不做诊断 / 处方；不确定就标注，绝不编造。",
    "",
    `---BEGIN 当日对话 raw/conversations/${day}.md---`,
    conversation,
    "---END 当日对话---",
    "---BEGIN 现有 observations.md---",
    observations || "(空)",
    "---END 现有 observations.md---",
    "---BEGIN 现有 timeline.md---",
    timeline || "(空)",
    "---END 现有 timeline.md---",
    "",
    "输出格式（严格遵守，不要额外解释）：",
    "===FILE: observations===",
    "<新增观察条目；没有就留空>",
    "===FILE: timeline===",
    "<新增时间线条目；没有就留空>",
    "===FILE: summary===",
    "<当日对话分析摘要>",
  ].join("\n");
}

function buildProfileDirective(observations: string, caseMd: string): string {
  return [
    "你是本患者工作区的知识库维护者，严格遵循 patient-wiki 技能（/skills/patient-wiki/SKILL.md）的画像算法。",
    "请从下面的 observations + case **重新推导**患者画像（不是在旧画像上迭代），每条断言必须引用 [obs:...]。",
    "画像只写非临床维度：沟通风格、情绪状态、依从性、生活事件、偏好、关注点。禁止推断疾病、严重程度、预后或用药合理性。",
    "顶部必须有免责声明：> ⚠️ 本画像由 AI 基于对话记录自动整理，仅用于辅助沟通与随访，不构成医疗判断，不替代医生诊断。",
    "冲突用 [!contradiction] 保留双方与日期；无来源的推断放到「待核实」。",
    "",
    "---BEGIN observations.md---",
    observations || "(空)",
    "---END observations.md---",
    "---BEGIN case.md---",
    caseMd || "(空)",
    "---END case.md---",
    "",
    "只输出 profile.md 的完整 Markdown 内容：不要解释、不要前言、不要用 ``` 代码块包裹。",
  ].join("\n");
}

function buildIngestDirective(
  rawPath: string,
  rawContent: string,
  existing: Record<string, string>,
): string {
  const today = shanghaiDay();
  return [
    "你是本患者工作区的知识库维护者，严格遵循 patient-wiki 技能（/skills/patient-wiki/SKILL.md）与 wiki 技能（/skills/wiki/SKILL.md）。",
    "请根据下面的原始病历资料，生成/更新患者 wiki 的 3 个文件：case.md、timeline.md、index.md。",
    "",
    `---BEGIN raw/${rawPath}---`,
    rawContent,
    `---END raw/${rawPath}---`,
    "",
    "---BEGIN 当前 case.md---",
    existing["case.md"] || "(空)",
    "---END 当前 case.md---",
    "---BEGIN 当前 timeline.md---",
    existing["timeline.md"] || "(空)",
    "---END 当前 timeline.md---",
    "---BEGIN 当前 index.md---",
    existing["index.md"] || "(空)",
    "---END 当前 index.md---",
    "",
    "要求：",
    "- case.md：病例概况（基本信息 / 主诉 / 现病史 / 既往史 / 体格检查 / 辅助检查 / 诊断 / 处理意见），照抄原文，不做临床解读、不诊断、不处方。",
    "- timeline.md：保留已有时间线，追加本次事件（日期 + 事件 + 出处）。",
    `- index.md：更新入口索引（各页面一句话摘要 + 本次记录 ${today} ingest | ${rawPath}）。`,
    "- 全部使用简体中文；非临床；不确定就标注，绝不编造。",
    "",
    "输出格式（严格遵守，不要任何额外解释或前言）：",
    "===FILE: case.md===",
    "<case.md 的完整 Markdown 内容>",
    "===FILE: timeline.md===",
    "<timeline.md 的完整 Markdown 内容>",
    "===FILE: index.md===",
    "<index.md 的完整 Markdown 内容>",
  ].join("\n");
}

function buildSingleFileDirective(
  name: string,
  rawPath: string,
  rawContent: string,
  existing: string,
): string {
  return [
    `请只生成患者 wiki 的 ${name} 文件的完整 Markdown 内容，严格遵循 patient-wiki 技能。`,
    "",
    `---BEGIN raw/${rawPath}---`,
    rawContent,
    `---END raw/${rawPath}---`,
    "",
    `---BEGIN 当前 ${name}---`,
    existing || "(空)",
    `---END 当前 ${name}---`,
    "",
    "只输出该文件内容本身：不要解释、不要前言、不要用 ``` 代码块包裹。",
  ].join("\n");
}
