/**
 * Per-patient workspace service (server-only).
 *
 * One engine serves N patients. Each device maps to exactly one workspace
 * directory under `AGENT_ROOT_DIR`:
 *
 *   <root>/patients/<safeId>/raw/    read-only source documents
 *   <root>/patients/<safeId>/wiki/   LLM-maintained knowledge base
 *
 * The agent sees the same tree through a virtual mount rooted at `/patients`
 * (see `patientVirtualDir`). This module owns the physical layout, the
 * idempotent seeding of the wiki, and the file-based retrieval tool.
 */

import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import type { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import { safeWorkspaceId, patientVirtualDir } from "@/lib/tenant";
import { shanghaiDay } from "@/lib/time";

const DEFAULT_TOP_K = 3;
const MAX_TOP_K = 8;
const MAX_WIKI_FILE_BYTES = 256 * 1024;
const DOSSIER_MAX_CHARS = 6000;
/** Budget for the always-included patient overview returned by retrieval. */
const OVERVIEW_MAX_CHARS = 2500;

export interface WorkspacePaths {
  root: string;
  raw: string;
  wiki: string;
  virtualRoot: string;
  virtualRaw: string;
  virtualWiki: string;
}

export interface EnsureWorkspaceResult {
  root: string;
  created: boolean;
}

export interface WorkspaceFile {
  path: string;
  virtualPath: string;
  size: number;
  modifiedAt: number;
}

export class WorkspaceFileNotFoundError extends Error {
  constructor(relPath: string) {
    super(`Workspace file not found: ${relPath}`);
    this.name = "WorkspaceFileNotFoundError";
  }
}

const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;
const LISTABLE_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv"]);
const REL_PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function sanitizeRelPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  if (!normalized || segments.length === 0) {
    throw new Error("Empty workspace file path");
  }
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`Invalid path segment in "${relPath}"`);
    }
    if (!REL_PATH_SEGMENT_RE.test(segment)) {
      throw new Error(`Invalid characters in path "${relPath}"`);
    }
  }
  return segments.join("/");
}

/** Absolute root that holds every patient workspace. */
export function workspaceRoot(): string {
  return process.env.AGENT_ROOT_DIR ?? "./work_dir";
}

/** Physical + virtual paths for one device's workspace. */
export function workspacePaths(deviceId: string): WorkspacePaths {
  const safeId = safeWorkspaceId(deviceId);
  const root = path.join(workspaceRoot(), "patients", safeId);
  const virtualRoot = patientVirtualDir(deviceId);
  return {
    root,
    raw: path.join(root, "raw"),
    wiki: path.join(root, "wiki"),
    virtualRoot,
    virtualRaw: `${virtualRoot}/raw`,
    virtualWiki: `${virtualRoot}/wiki`,
  };
}

/**
 * Create the workspace tree if needed and seed the wiki files.
 *
 * Never overwrites existing content — seeds are written with the exclusive
 * `wx` flag, so concurrent callers and pre-existing notes are safe. Idempotent.
 */
export async function ensureWorkspace(deviceId: string): Promise<EnsureWorkspaceResult> {
  const paths = workspacePaths(deviceId);

  let created = false;
  try {
    await stat(paths.wiki);
  } catch {
    created = true;
  }

  await mkdir(paths.raw, { recursive: true });
  await mkdir(paths.wiki, { recursive: true });

  await mkdir(path.join(paths.wiki, "conversations"), { recursive: true });
  await mkdir(path.join(paths.raw, "conversations"), { recursive: true });
  await mkdir(path.join(paths.raw, "uploads"), { recursive: true });
  await mkdir(path.join(paths.raw, "case"), { recursive: true });
  await mkdir(path.join(paths.raw, "assets"), { recursive: true });

  await seedIfMissing(path.join(paths.wiki, "index.md"), indexSeed());
  await seedIfMissing(path.join(paths.wiki, "log.md"), logSeed());
  await seedIfMissing(path.join(paths.wiki, "observations.md"), observationsSeed());
  await seedIfMissing(path.join(paths.wiki, "profile.md"), profileSeed());
  await seedIfMissing(path.join(paths.wiki, "case.md"), caseSeed());
  await seedIfMissing(path.join(paths.wiki, "timeline.md"), timelineSeed());

  return { root: paths.root, created };
}

export async function writeRawFile(
  deviceId: string,
  relPath: string,
  content: string,
): Promise<{ path: string; virtualPath: string; size: number }> {
  await ensureWorkspace(deviceId);
  const paths = workspacePaths(deviceId);
  const safeRel = sanitizeRelPath(relPath);
  const rawRoot = path.resolve(paths.raw);
  const physical = path.resolve(rawRoot, safeRel);
  if (physical !== rawRoot && !physical.startsWith(rawRoot + path.sep)) {
    throw new Error(`Path escapes raw directory: ${relPath}`);
  }

  await mkdir(path.dirname(physical), { recursive: true });
  await writeFile(physical, content, "utf8");

  return {
    path: physical,
    virtualPath: `${paths.virtualRaw}/${safeRel}`,
    size: Buffer.byteLength(content, "utf8"),
  };
}

export async function writeWikiFile(
  deviceId: string,
  relPath: string,
  content: string,
): Promise<{ path: string; virtualPath: string; size: number }> {
  await ensureWorkspace(deviceId);
  const paths = workspacePaths(deviceId);
  const safeRel = sanitizeRelPath(relPath);
  const wikiRoot = path.resolve(paths.wiki);
  const physical = path.resolve(wikiRoot, safeRel);
  if (physical !== wikiRoot && !physical.startsWith(wikiRoot + path.sep)) {
    throw new Error(`Path escapes wiki directory: ${relPath}`);
  }

  await mkdir(path.dirname(physical), { recursive: true });
  await writeFile(physical, content, "utf8");

  return {
    path: physical,
    virtualPath: `${paths.virtualWiki}/${safeRel}`,
    size: Buffer.byteLength(content, "utf8"),
  };
}

export async function readRawFile(deviceId: string, relPath: string): Promise<string> {
  await ensureWorkspace(deviceId);
  const paths = workspacePaths(deviceId);
  const safeRel = sanitizeRelPath(relPath);
  const rawRoot = path.resolve(paths.raw);
  const physical = path.resolve(rawRoot, safeRel);
  if (physical !== rawRoot && !physical.startsWith(rawRoot + path.sep)) {
    throw new Error(`Path escapes raw directory: ${relPath}`);
  }

  const info = await stat(physical);
  if (!info.isFile()) throw new Error(`Not a file: ${relPath}`);
  if (info.size > MAX_WORKSPACE_FILE_BYTES) throw new Error(`File too large: ${relPath}`);
  return readFile(physical, "utf8");
}

export async function listWorkspaceFiles(
  deviceId: string,
): Promise<{ raw: WorkspaceFile[]; wiki: WorkspaceFile[] }> {
  await ensureWorkspace(deviceId);
  const paths = workspacePaths(deviceId);

  const [raw, wiki] = await Promise.all([
    collectWorkspaceFiles(paths.raw, paths.virtualRaw),
    collectWorkspaceFiles(paths.wiki, paths.virtualWiki),
  ]);

  raw.sort((a, b) => a.virtualPath.localeCompare(b.virtualPath));
  wiki.sort((a, b) => a.virtualPath.localeCompare(b.virtualPath));

  return { raw, wiki };
}

export async function readWorkspaceFile(deviceId: string, relPath: string): Promise<string> {
  await ensureWorkspace(deviceId);
  const paths = workspacePaths(deviceId);
  const safeRel = sanitizeRelPath(relPath);

  const wikiContent = await tryReadWorkspaceFile(
    path.resolve(paths.wiki, safeRel),
    path.resolve(paths.wiki),
  );
  if (wikiContent !== null) return wikiContent;

  const rawContent = await tryReadWorkspaceFile(
    path.resolve(paths.raw, safeRel),
    path.resolve(paths.raw),
  );
  if (rawContent !== null) return rawContent;

  throw new WorkspaceFileNotFoundError(relPath);
}

async function tryReadWorkspaceFile(candidate: string, baseDir: string): Promise<string | null> {
  const resolved = path.resolve(candidate);
  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) return null;

  let info;
  try {
    info = await stat(resolved);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  if (info.size > MAX_WORKSPACE_FILE_BYTES) {
    throw new Error(
      `Workspace file exceeds ${MAX_WORKSPACE_FILE_BYTES} bytes: ${path.basename(resolved)}`,
    );
  }
  return readFile(resolved, "utf8");
}

async function collectWorkspaceFiles(
  baseDir: string,
  virtualBase: string,
): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!LISTABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

      try {
        const info = await stat(full);
        const rel = path.relative(baseDir, full).split(path.sep).join("/");
        files.push({
          path: rel,
          virtualPath: `${virtualBase}/${rel}`,
          size: info.size,
          modifiedAt: info.mtimeMs,
        });
      } catch {
        continue;
      }
    }
  }

  await walk(baseDir);
  return files;
}

/**
 * Build a read-only retrieval tool scoped to one device's wiki.
 *
 * Scoring is intentionally dependency-free: blocks are ranked by
 * case-insensitive occurrences of the full query plus each whitespace token.
 */
export function buildWikiRetrievalTool(deviceId: string): StructuredTool {
  const virtualRoot = patientVirtualDir(deviceId);

  return tool(
    async ({ query, topK }: { query: string; topK?: number }) => {
      try {
        const { raw, wiki } = workspacePaths(deviceId);
        const [wikiBlocks, rawBlocks] = await Promise.all([
          loadWorkspaceBlocks(wiki, "wiki"),
          loadWorkspaceBlocks(raw, "raw"),
        ]);
        const blocks = [...wikiBlocks, ...rawBlocks];
        if (blocks.length === 0) {
          return `The patient workspace at ${virtualRoot} has no readable records yet — no knowledge to retrieve.`;
        }

        const tokens = query
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length > 0);
        const ranked = blocks
          .map((block) => ({ ...block, score: scoreBlock(block.text, query, tokens) }))
          .filter((block) => block.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK ?? DEFAULT_TOP_K);

        // Always surface a bounded overview of the patient's核心记录. Natural
        // Chinese questions ("我叫什么名字") share no literal substring with the
        // stored fields ("姓名：Tom"), so pure keyword ranking alone can return
        // nothing. The overview guarantees the patient's identity and diagnosis
        // are present whenever the model consults the record.
        const overview = await buildPatientOverview(deviceId);

        if (ranked.length === 0) {
          if (overview) {
            return `患者核心资料(${virtualRoot}/wiki/):\n\n${overview}`;
          }
          return `No relevant records found for "${query}" in ${virtualRoot}. Answer from general knowledge and say the patient records had no match.`;
        }

        const matches = ranked
          .map((block, i) => `[${i + 1}] (${block.source}/${block.relPath})\n${block.text}`)
          .join("\n\n");

        return overview
          ? `患者核心资料(${virtualRoot}/wiki/):\n\n${overview}\n\n---\n\n检索命中片段:\n\n${matches}`
          : `检索命中片段:\n\n${matches}`;
      } catch (err) {
        return `[patient retrieval error] ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: "retrieve_patient_wiki",
      description:
        `Retrieves relevant records from the patient's private workspace: the maintained wiki ` +
        `(${virtualRoot}/wiki/) and the patient's uploaded source records ` +
        `(${virtualRoot}/raw/, e.g. 病历 / 检查报告 under raw/uploads/). Call this BEFORE answering ` +
        `any patient-specific question (name, history, condition, medications, preferences). ` +
        `Returns the top matching markdown blocks with their source path; cite the returned path.`,
      schema: z.object({
        query: z.string().min(1).describe("Natural-language search query"),
        topK: z.number().int().min(1).max(MAX_TOP_K).optional(),
      }),
    },
  );
}

/**
 * Compact, bounded snapshot of the patient's authoritative records.
 *
 * Built from the maintained wiki files — identity and diagnosis live in
 * `case.md` / `profile.md`. Retrieval always includes this so a natural-language
 * question still reaches the patient's basics even when keyword ranking finds
 * no literal match.
 */
async function buildPatientOverview(deviceId: string): Promise<string> {
  const { wiki } = workspacePaths(deviceId);
  const names = ["case.md", "profile.md", "index.md", "timeline.md"];
  const parts: string[] = [];
  let used = 0;

  for (const name of names) {
    let content: string;
    try {
      content = (await readFile(path.join(wiki, name), "utf8")).trim();
    } catch {
      continue;
    }
    if (!content) continue;

    const remaining = OVERVIEW_MAX_CHARS - used;
    if (remaining <= 0) break;
    if (content.length > remaining) {
      if (remaining > 200) parts.push(`(${name})\n${content.slice(0, remaining)}…`);
      break;
    }
    parts.push(`(${name})\n${content}`);
    used += content.length;
  }

  const card = buildIdentityCard(parts.join("\n"));
  return card ? `${card}\n\n${parts.join("\n\n")}` : parts.join("\n\n");
}

/**
 * Synthesise an unambiguous identity header from the raw wiki text.
 *
 * Small local models conflate the assistant's own name with the patient's when
 * the record is presented as plain Markdown ("**姓名**: Tom"). Spelling out the
 * distinction once, in the retrieved payload itself, keeps the pronoun straight.
 */
function buildIdentityCard(wikiText: string): string {
  const pick = (label: string): string | undefined => {
    const re = new RegExp(`\\*\\*${label}\\*\\*\\s*[:：]\\s*([^\\n*]+)`);
    const m = wikiText.match(re);
    return m?.[1]?.trim() || undefined;
  };

  /** Body of a `## Heading` section, collapsed onto one line. */
  const pickSection = (heading: string): string | undefined => {
    const m = wikiText.match(
      new RegExp(`##+\\s*${heading}\\s*\\n([\\s\\S]*?)(?=\\n##+\\s|\\n\\(|\$)`),
    );
    const body = m?.[1]
      ?.split("\n")
      .map((l) => l.replace(/^\s*\d+[.、)]\s*/, "").trim())
      .filter(Boolean)
      .join("；");
    return body || undefined;
  };

  const fields: Array<[string, string | undefined]> = [
    ["姓名", pick("姓名")],
    ["性别", pick("性别")],
    ["年龄", pick("年龄")],
    ["职业", pick("职业")],
    ["婚姻", pick("婚姻") ?? pick("婚姻状况")],
    ["诊断", pickSection("诊断")],
  ];
  const present = fields.filter(([, v]) => Boolean(v));
  if (present.length === 0) return "";

  const name = pick("姓名");
  const lines = present.map(([k, v]) => `- ${k}:${v}`).join("\n");
  return (
    `## 病人身份(权威,以此为准)\n${lines}\n` +
    `\n> 以上是**病人**的信息。回答时称呼病人为"你",例如"你叫${name ?? "…"}"。\n` +
    `> 你自己的名字是 Andy。**不要**说"我是${name ?? "XXX"}"这种把病人名字安在自己身上的话。\n` +
    `> 这份档案**没有**写爱好、日常喜好、家庭成员姓名等内容;问到时如实说"我这边还没有这方面的记录",**不要编造**。`
  );
}

/** Short system-prompt section describing the patient workspace + retrieval tool. */
export function buildWikiSystemHint(deviceId: string): string {
  const virtualRoot = patientVirtualDir(deviceId);
  return (
    `\n\n## Patient workspace\n` +
    `You are the companion for ONE patient; their private workspace is mounted at \`${virtualRoot}/\`.\n` +
    `- \`${virtualRoot}/raw/\` holds the patient's source records (uploaded 病历/检查报告 under \`raw/uploads/\`, daily conversations under \`raw/conversations/\`) — READ-ONLY.\n` +
    `- \`${virtualRoot}/wiki/\` is the maintained knowledge base (index.md, log.md, observations.md, profile.md, case.md, timeline.md).\n` +
    `- Before answering ANY patient-specific question (their name, history, condition, medications, preferences), call \`retrieve_patient_wiki\` and cite the returned path. The patient's records are the source of truth about the patient.\n` +
    `- IMPORTANT: when the patient asks "我叫什么" / "我的情况", they are asking about THEMSELVES. Look it up in their records and answer with the patient's information — never answer with your own name or identity.`
  );
}

export async function buildPatientDossier(
  deviceId: string,
  maxChars: number = DOSSIER_MAX_CHARS,
): Promise<string> {
  await ensureWorkspace(deviceId);
  const paths = workspacePaths(deviceId);
  const sections: string[] = [];

  const uploads = await collectMarkdownFiles(path.join(paths.raw, "uploads"));
  uploads.sort();
  for (const file of uploads) {
    const content = await readBoundedFile(file);
    if (content) sections.push(`--- 上传的原始资料 ---\n${content}`);
  }

  const wikiLabels: Record<string, string> = {
    "profile.md": "--- 患者画像 ---",
    "case.md": "--- 病例概况 ---",
    "observations.md": "--- 观察记录 ---",
    "timeline.md": "--- 病程时间线 ---",
    "index.md": "--- 知识库索引 ---",
  };
  for (const name of ["profile.md", "case.md", "observations.md", "timeline.md", "index.md"]) {
    const content = await readBoundedFile(path.join(paths.wiki, name));
    if (content) sections.push(`${wikiLabels[name]}\n${content}`);
  }

  let out = "";
  for (const section of sections) {
    if (out.length + section.length + 2 > maxChars) break;
    out += (out ? "\n\n" : "") + section;
  }
  return out;
}

async function readBoundedFile(filePath: string): Promise<string> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > MAX_WIKI_FILE_BYTES) return "";
    return (await readFile(filePath, "utf8")).trim();
  } catch {
    return "";
  }
}

function indexSeed(): string {
  return [
    "# Patient Wiki",
    "",
    "This is the entry point of the patient's private knowledge base.",
    "The assistant maintains this wiki: record durable, patient-specific facts",
    "here and link to any notes stored alongside this file.",
    "",
  ].join("\n");
}

function logSeed(): string {
  return [
    "# Wiki Change Log",
    "",
    `## [${shanghaiDay()}] init | workspace created`,
    "",
  ].join("\n");
}

function observationsSeed(): string {
  return [
    "# Observations (append-only)",
    "",
    "Entries are appended as `### [obs:YYYY-MM-DD-N]` blocks containing the",
    "patient's 原话 and its 出处. This file is append-only: never edit or",
    "delete an existing entry.",
    "",
  ].join("\n");
}

function profileSeed(): string {
  return [
    "> ⚠️ AI 自动整理，仅用于辅助沟通，不构成医疗判断，不替代医生诊断。",
    "",
    "## 尚未生成",
    "",
  ].join("\n");
}

function caseSeed(): string {
  return ["# Case", "", "待补充（照抄原文，不做临床解读）", ""].join("\n");
}

function timelineSeed(): string {
  return ["# Timeline", "", "| 日期 | 事件 | 出处 |", "| --- | --- | --- |", ""].join(
    "\n",
  );
}

async function seedIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

interface WorkspaceBlock {
  relPath: string;
  source: "wiki" | "raw";
  text: string;
}

async function loadWorkspaceBlocks(
  dir: string,
  source: "wiki" | "raw",
): Promise<WorkspaceBlock[]> {
  const files = await collectMarkdownFiles(dir);
  const blocks: WorkspaceBlock[] = [];

  for (const file of files) {
    try {
      const info = await stat(file);
      if (info.size > MAX_WIKI_FILE_BYTES) continue;
      const content = await readFile(file, "utf8");
      const relPath = path.relative(dir, file).split(path.sep).join("/");
      for (const raw of content.split(/\n{2,}/)) {
        const text = raw.trim();
        if (text) blocks.push({ relPath, source, text });
      }
    } catch {
      continue;
    }
  }

  return blocks;
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(full)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

function scoreBlock(text: string, query: string, tokens: string[]): number {
  const haystack = text.toLowerCase();
  const needle = query.trim().toLowerCase();

  let score = 0;
  if (needle) score += 10 * countOccurrences(haystack, needle);
  for (const token of tokens) {
    score += countOccurrences(haystack, token);
  }
  // Chinese has no whitespace word boundaries, so a natural question
  // ("我叫什么名字") shares no whole token with stored field names
  // ("**姓名**: Tom"). Character-bigram overlap gives those queries a signal.
  score += bigramOverlap(haystack, needle);
  return score;
}

/**
 * Number of distinct character bigrams the query and the text share.
 *
 * CJK-aware and dependency-free; punctuation and whitespace are dropped before
 * slicing so "我叫什么名字？" and "我叫什么名字" behave identically.
 */
function bigramOverlap(haystack: string, needle: string): number {
  const compact = needle.replace(/[\s\p{P}\p{S}]+/gu, "");
  if (compact.length < 2) return 0;

  const grams = new Set<string>();
  for (let i = 0; i < compact.length - 1; i++) {
    grams.add(compact.slice(i, i + 2));
  }

  let hits = 0;
  for (const gram of grams) {
    if (haystack.includes(gram)) hits += 1;
  }
  return hits * 2;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}
