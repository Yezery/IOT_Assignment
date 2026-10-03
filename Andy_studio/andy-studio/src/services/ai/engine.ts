/**
 * Engine — core agent invocation layer.
 *
 * Responsibilities (only these):
 *   1. Cache `createDeepAgent` instances keyed by (provider, level, systemPrompt).
 *   2. Wire LLM + MCP tools + Skills directory into each instance.
 *   3. Call the agent and extract the longest assistant text (with
 *      `<think>` blocks stripped).
 *
 * Business fields never appear here. Engine is a pure runtime.
 */

import { createHash } from "node:crypto";
import { createDeepAgent, FilesystemBackend, registerHarnessProfile } from "deepagents";
import type { FilesystemPermission } from "deepagents";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { StructuredTool } from "@langchain/core/tools";
import { createMCPTools } from "./mcp";
import { composeSystemPrompt } from "./prompts";
import { getLLMConfig, getModelKwargsForThinking } from "./llm";
import { getActiveProviderName } from "./provider-store";
import { getSettings, ensureSettingsLoaded } from "./settings-store";
import { shanghaiDay, formatShanghaiDateTime } from "@/lib/time";
import { safeWorkspaceId } from "@/lib/tenant";
import type { CallOpts, ThinkingLevel } from "./types";

const cache = new Map<string, ReturnType<typeof createDeepAgent>>();

const systemFingerprint = (system: string) =>
  createHash("sha1").update(system).digest("hex").slice(0, 16);

const cacheKey = (
  provider: string,
  level: ThinkingLevel,
  system: string,
  emotion: string | undefined,
  scope: string | undefined,
) =>
  `${provider}::${level}::${emotion ?? ""}::${scope ?? ""}::${shanghaiDay()}::${systemFingerprint(system)}`;

const ROOT = () => process.env.AGENT_ROOT_DIR ?? "./work_dir";
const SKILLS = () => process.env.AGENT_SKILLS_DIR ?? "./skills";

let harnessProfileRegistered = false;

function ensureHarnessProfile(): void {
  if (harnessProfileRegistered) return;
  registerHarnessProfile("openai", {
    excludedTools: ["execute"],
    generalPurposeSubagent: { enabled: false },
  });
  harnessProfileRegistered = true;
}

/**
 * First-match-wins filesystem rules confining a scoped agent to its own
 * patient workspace, with `/raw/**` writes denied and skills readable.
 */
function scopePermissions(scope: string): FilesystemPermission[] {
  const dir = `/patients/${safeWorkspaceId(scope)}`;
  return [
    { operations: ["write"], paths: [`${dir}/raw/**`], mode: "deny" },
    { operations: ["read", "write"], paths: [`${dir}/**`] },
    { operations: ["read"], paths: ["/skills/**"] },
    { operations: ["read", "write"], paths: ["/**"], mode: "deny" },
  ];
}

/**
 * Resolve (and cache) a deepagent instance for the given options.
 *
 * HMR-safe via the module-level cache map — repeated calls with the
 * same key return the same compiled graph.
 */
export async function getAgent(opts: CallOpts = {}): Promise<
  ReturnType<typeof createDeepAgent>
> {
  const provider = opts.provider ?? await getActiveProviderName();
  const level: ThinkingLevel = opts.thinkingLevel ?? "normal";
  const system = composeSystemPrompt({
    soul: opts.soul,
    systemPrompt: opts.systemPrompt,
    devicePrompt: opts.devicePrompt,
    emotion: opts.emotion,
    systemHint: opts.systemHint,
  });
  const key = cacheKey(provider, level, system, opts.emotion, opts.scope);

  const cached = cache.get(key);
  if (cached) return cached;

  const llm = await getLLMConfig(provider);
  // An unscoped call is a plain chat only. Never attach filesystem-backed
  // skills, MCP, or per-device tools until an authorized tenant scope exists.
  const mcp = opts.scope ? await createMCPTools() : [];
  const extras = opts.scope ? (opts.extraTools ?? []) as StructuredTool[] : [];
  const tools: StructuredTool[] = [
    ...(mcp as StructuredTool[]),
    ...extras,
  ];

  // Settings UI takes precedence over the explicit opts.
  await ensureSettingsLoaded();
  const settings = getSettings();
  const temperature = opts.temperature ?? settings.temperature;
  const thinkingEnabled = opts.thinking ?? settings.thinking;
  const maxTokens = opts.maxTokens ?? settings.maxTokens ?? undefined;
  const modelKwargs = getModelKwargsForThinking(thinkingEnabled);

  const modelName = llm.model.startsWith("openai:")
    ? llm.model.slice("openai:".length)
    : llm.model;
  const normalizedBaseUrl = llm.baseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
  console.log(
    `[Agent] provider=${llm.name} model=${modelName} baseURL=${llm.baseURL}/v1 ` +
      `temp=${temperature} thinking=${thinkingEnabled} maxTokens=${maxTokens ?? "default"}`,
  );

  // ChatOpenAI validates credentials before it sends a request. Ollama's
  // local OpenAI-compatible endpoint normally ignores auth, so always retain
  // a harmless placeholder even if a stale provider cache returns an empty key.
  const apiKey = llm.apiKey || (provider === "local" ? "ollama" : "");
  if (!apiKey) {
    throw new Error(`LLM provider "${provider}" has no API key configured`);
  }
  const model = new ChatOpenAI({
    model: modelName,
    temperature,
    apiKey,
    ...(maxTokens ? { maxTokens } : {}),
    configuration: { baseURL: `${normalizedBaseUrl}/v1` },
    ...(Object.keys(modelKwargs).length ? { modelKwargs } : {}),
  });

  ensureHarnessProfile();
  const inst = createDeepAgent({
    model,
    systemPrompt: system,
    backend: new FilesystemBackend({ rootDir: ROOT(), virtualMode: true }),
    tools,
    ...(opts.scope
      ? { skills: [`${SKILLS()}/`], permissions: scopePermissions(opts.scope) }
      : { permissions: [{ operations: ["read", "write"], paths: ["/**"], mode: "deny" }] }),
  });
  cache.set(key, inst);
  return inst;
}

export function resetCache(): void {
  cache.clear();
}

/* ============ thinking strip ============ */

export function stripThinking(text: string): string {
  if (!text) return text;
  const closed = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (closed) return closed;
  const unclosed = text.replace(/<think>[\s\S]*/gi, "").trim();
  if (unclosed) return unclosed;
  const m = text.match(/<think>([\s\S]*?)(?:<\/think>|$)/i);
  if (m) return m[1].trim();
  return text.trim();
}

/* ============ extract final ============ */

function resolveContent(m: unknown): string {
  const c = (m as { content?: unknown })?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (typeof b === "string") return b;
        const obj = b as { type?: string; text?: string };
        if (obj?.type === "text") return obj.text ?? "";
        return "";
      })
      .join("");
  }
  return "";
}

function messageType(m: unknown): string {
  const mm = m as { role?: unknown; type?: unknown; _getType?: unknown };
  if (typeof mm.role === "string") return mm.role;
  if (typeof mm.type === "string") return mm.type;
  if (typeof mm._getType === "function") return (mm._getType as () => string)();
  return "";
}

function extractFinal(messages: unknown[]): string {
  let best = "";
  for (const m of messages) {
    const type = messageType(m);
    if (type !== "AIMessage" && type !== "ai" && type !== "assistant") continue;
    const content = resolveContent(m);
    if (content.length > best.length) best = content;
  }
  if (best) return stripThinking(best);
  for (const m of messages) {
    const content = resolveContent(m);
    if (content.length > best.length) best = content;
  }
  return stripThinking(best);
}

/* ============ public API ============ */

export interface CallResult {
  content: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
  toolResults: string[];
}

export interface StreamChunk extends CallResult {
  done: boolean;
  /**
   * Snapshot of the full message list as of this chunk. Consumers can
   * inspect `messages` to filter out intermediate tool-call turns and
   * stream only the final assistant reply.
   */
  messages?: unknown[];
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function extractCallResult(messages: unknown[]): CallResult {
  const toolCalls: CallResult["toolCalls"] = [];
  const toolResults: string[] = [];
  for (const m of messages as Array<{
    tool_calls?: Array<{ name: string; args: unknown }>;
    role?: string;
    content?: unknown;
  }>) {
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        toolCalls.push({
          name: tc.name,
          args:
            typeof tc.args === "string"
              ? safeJson(tc.args)
              : ((tc.args ?? {}) as Record<string, unknown>),
        });
      }
    }
    if (
      messageType(m) === "tool" &&
      typeof m.content === "string" &&
      m.content.trim()
    ) {
      toolResults.push(m.content);
    }
  }
  return { content: extractFinal(messages), toolCalls, toolResults };
}

function buildMessages(history: CallOpts["history"], prompt: string): unknown[] {
  const msgs: unknown[] = [];
  for (const h of history ?? [])
    msgs.push(
      h.role === "assistant" ? new AIMessage(h.content) : new HumanMessage(h.content),
    );
  msgs.push(new HumanMessage(`[系统时间] ${formatShanghaiDateTime()}\n${prompt}`));
  return msgs;
}

/**
 * Local Ollama runs a real tool-calling loop rather than the DeepAgent graph.
 *
 * Rationale: Ollama models commonly use a strict Jinja template that accepts a
 * system message only in position zero, which DeepAgent's middleware/tool state
 * violates. The loop below keeps one stable system-first message array while
 * still letting the model call the same tools the cloud path gets (patient wiki
 * retrieval, chat history). Without this, prompts like "我叫什么名字" reached the
 * model with no way to look the patient up.
 */

/** Build the ChatOpenAI instance shared by the local loop. */
async function buildLocalModel(
  opts: CallOpts,
  overrides: { temperature?: number } = {},
): Promise<{ model: ChatOpenAI }> {
  const provider = opts.provider ?? (await getActiveProviderName());
  const llm = await getLLMConfig(provider);
  const settings = await ensureSettingsLoaded();
  const modelName = llm.model.startsWith("openai:")
    ? llm.model.slice("openai:".length)
    : llm.model;
  const baseURL = llm.baseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
  const thinking = opts.thinking ?? settings.thinking;
  const modelKwargs = {
    ...getModelKwargsForThinking(thinking),
    ...(thinking ? {} : { think: false }),
  };
  const maxTokens = opts.maxTokens ?? settings.maxTokens ?? undefined;
  const model = new ChatOpenAI({
    model: modelName,
    temperature: overrides.temperature ?? opts.temperature ?? settings.temperature,
    apiKey: llm.apiKey || "ollama",
    ...(maxTokens ? { maxTokens } : {}),
    configuration: { baseURL: `${baseURL}/v1` },
    ...(Object.keys(modelKwargs).length ? { modelKwargs } : {}),
  });
  return { model };
}

/**
 * Temperature used when the answer must be grounded in the patient's record.
 *
 * Small local models follow "answer only from these facts" instructions far
 * more reliably at low temperature; the conversational default (0.7) makes them
 * drift into invented detail.
 */
const LOCAL_GROUNDED_TEMPERATURE = Number(
  process.env.LOCAL_AGENT_GROUNDED_TEMPERATURE ?? "0.15",
);

/** Wrap tool output so the model treats it as data, not as new instructions. */
function fenceToolResult(name: string, output: string): string {
  return `<tool_result name="${name}">\n${output}\n</tool_result>`;
}

/**
 * Questions that can only be answered from the patient's own record.
 *
 * Used as a safety net: if the model answers one of these without consulting
 * any tool, the server performs the lookup itself rather than shipping a
 * generic answer.
 */
const PATIENT_QUESTION_RE =
  /我(叫|是|的)?(什么|啥|哪位|谁)?(名字|姓名)|我是谁|我的(名字|姓名|病|病情|情况|病史|病历|用药|年龄|资料)|还记(得|不记得)我|我之前(说|聊|提)|上次(说|聊|提)|记得我/;

/**
 * Topic keywords that, combined with a first-person reference, mean the patient
 * is asking about their own record ("我得了什么病", "我今天吃了什么").
 */
const PATIENT_TOPIC_RE =
  /名字|姓名|叫什么|多大|年龄|岁数|病|病情|病史|病历|诊断|症状|用药|吃药|药|医生|医院|检查|治疗|住院|过敏|血压|血糖|睡眠|睡|胃口|吃饭|疼|痛|晕|难受|记忆|忘|糊涂|爱好|喜欢|平时|以前|过去|家人|孩子|儿子|女儿|老伴|老婆|丈夫|妻子|孙子|孙女|朋友|工作|职业|退休|老家|哪里人|住哪/;

const FIRST_PERSON_RE = /我|自己|咱/;

/**
 * "Can you see / do you know my record?" — a question about the assistant's
 * awareness of the patient, not about a single fact in the record.
 *
 * These need their own answer shape: the model must confirm it has the record
 * and summarise it. Treated as an ordinary lookup, a small model finds no
 * literal fact answering "can you see my data" and wrongly replies that there
 * is no record.
 */
const AWARENESS_VERB_RE = /看到|看见|查看|读取|知道|了解|记得|认识|掌握|拿到|有/;
const AWARENESS_OBJECT_RE = /(我的|关于我的|我)(的)?(资料|信息|档案|病历|记录|情况|数据|名字|姓名|东西)/;
const AWARENESS_SUBJECT_RE = /你|您/;

function looksRecordAwarenessQuestion(prompt: string): boolean {
  // "你了解我吗" / "你知道我吗" / "你还记得我吗"
  if (/(你|您)[^。！？\n]{0,4}(了解|知道|记得|认识)我(吗|么|嘛|不|没有|没有啊)?/.test(prompt)) {
    return true;
  }
  return (
    AWARENESS_SUBJECT_RE.test(prompt) &&
    AWARENESS_VERB_RE.test(prompt) &&
    AWARENESS_OBJECT_RE.test(prompt)
  );
}

/**
 * Does this prompt require the patient's own record to answer well?
 *
 * Erring towards `true` is safe: a pre-fetched record only adds grounded facts,
 * while a missed detection produces a generic reply that ignores the wiki
 * entirely — the exact failure this guard exists to prevent.
 */
function looksPatientRelated(prompt: string): boolean {
  if (looksRecordAwarenessQuestion(prompt)) return true;
  if (PATIENT_QUESTION_RE.test(prompt)) return true;
  return FIRST_PERSON_RE.test(prompt) && PATIENT_TOPIC_RE.test(prompt);
}

/**
 * Budgets for the local path.
 *
 * Ollama commonly runs a 4096-token context. The persona/RULES prompt is large
 * on its own, so history and any pre-fetched patient record must be trimmed or
 * the request is rejected with `exceed_context_size_error`.
 */
const LOCAL_HISTORY_TURNS = Math.max(0, Number(process.env.LOCAL_AGENT_HISTORY_TURNS ?? "4"));
const LOCAL_HISTORY_MSG_CHARS = Math.max(40, Number(process.env.LOCAL_AGENT_HISTORY_CHARS ?? "160"));
const LOCAL_RECORD_MAX_CHARS = Math.max(200, Number(process.env.LOCAL_AGENT_RECORD_CHARS ?? "1200"));

/** Keep only the most recent turns, each truncated, to respect the context budget. */
function compactHistory(
  history: CallOpts["history"],
): { role: "user" | "assistant"; content: string }[] {
  const items = history ?? [];
  if (items.length === 0) return [];
  return items.slice(-LOCAL_HISTORY_TURNS).map((h) => ({
    role: h.role,
    content:
      h.content.length > LOCAL_HISTORY_MSG_CHARS
        ? `${h.content.slice(0, LOCAL_HISTORY_MSG_CHARS)}…`
        : h.content,
  }));
}

/** Trim a pre-fetched record so it cannot exhaust the context window. */
function clampRecord(context: string): string {
  if (context.length <= LOCAL_RECORD_MAX_CHARS) return context;
  return `${context.slice(0, LOCAL_RECORD_MAX_CHARS)}…`;
}

/** Pull the patient's name out of the identity card in the fetched record. */
function extractPatientName(recordContext: string): string | undefined {
  const m = recordContext.match(/-\s*姓名\s*[:：]\s*([^\n*]+)/);
  return m?.[1]?.trim() || undefined;
}

/** Pull the patient's numeric age out of the identity card. */
function extractPatientAge(recordContext: string): string | undefined {
  const m = recordContext.match(/-\s*年龄\s*[:：]\s*(\d{1,3})/);
  return m?.[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministic guard for the assistant/patient identity mix-up.
 *
 * The RULES forbid speaking about the patient in the first person, but small
 * local models still slip. Because the patient's name and age are known from
 * the fetched record, the unambiguous phrasings can be rewritten safely:
 * a first-person claim carrying a known patient fact becomes a second-person
 * address. Only values taken from the record are rewritten, so a genuine
 * self-statement ("我今年 3 岁" for a 76-year-old patient) is left untouched.
 */
function fixPatientPronouns(
  text: string,
  patientName: string | undefined,
  patientAge: string | undefined,
): string {
  let s = text;

  if (patientName) {
    const name = escapeRegExp(patientName);
    s = s.replace(
      new RegExp(`我(叫|名字叫|的名字是|叫做|是)\\s*${name}`, "g"),
      `你$1${patientName}`,
    );
  }

  if (patientAge) {
    s = s.replace(
      new RegExp(`我(今年|已经|现在)?\\s*${patientAge}\\s*岁`, "g"),
      (_m, lead: string | undefined) =>
        `你${lead ? `${lead} ` : ""}${patientAge} 岁`,
    );
  }

  return s;
}

/**
 * Append an explicit inventory of the tools that actually exist on this call.
 *
 * The shared RULES prompt tells the model to read `/skills/patient-wiki/SKILL.md`
 * with filesystem tools. The local path has none, so without this contract the
 * model tries to follow instructions it cannot execute and falls back to
 * persona chit-chat instead of looking the patient up.
 */
function buildToolContract(tools: StructuredTool[]): string {
  if (tools.length === 0) return "";
  const list = tools
    .map((t) => `- \`${t.name}\`: ${String(t.description ?? "").split("\n")[0]}`)
    .join("\n");
  return (
    `\n\n## 本次会话可用的工具(权威,覆盖上文任何矛盾说明)\n` +
    `你在本次会话中**只有**以下工具:\n${list}\n\n` +
    `你**没有**文件系统工具,也**无法**读取 \`/skills/...\` 或任何文件路径。` +
    `上文若要求你"先读 SKILL.md"或"用文件工具读取",一律改用上面的工具完成。\n` +
    `**强制规则**:当用户询问任何与病人本人有关的信息(姓名、年龄、病情、病史、用药、偏好、上次聊过什么)时,` +
    `你**必须先调用**相关工具查询,再依据查询结果回答。` +
    `禁止在未查询的情况下猜测、回避,更**禁止**用你自己的名字或身份作答(例如不要说"我叫 Andy")。\n` +
    `**只答已知**:查询结果即为唯一事实依据。结果里没有写到的内容(例如爱好、家庭成员、日常习惯)就是**没有记录**,` +
    `必须直接回答"我这边还没有这方面的记录"。` +
    `**严禁**用常识、想象或"一般老人会…"来补全;严禁把别人的经历安到这位病人身上。`
  );
}

/**
 * Pick the tool that retrieves the patient's own records.
 *
 * Wiki mode exposes `retrieve_patient_wiki`; RAG mode exposes a per-device
 * `retrieve_device_<id>_knowledge`. Both accept `{ query }`.
 */
function pickRecordRetriever(tools: StructuredTool[]): StructuredTool | undefined {
  return (
    tools.find((t) => t.name === "retrieve_patient_wiki") ??
    tools.find((t) => t.name.startsWith("retrieve_device_"))
  );
}

async function invokeTool(tool: StructuredTool, query: string): Promise<string> {
  try {
    const result = await tool.invoke({ query } as never);
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (err) {
    return `[tool error] ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Run the local model as a tool-using agent.
 *
 * Two mechanisms cooperate to make patient questions work on small local models
 * that cannot be relied on to choose a tool by themselves:
 *
 *   1. Tool calling is enabled, so the model can request more detail itself.
 *   2. For questions that obviously target the patient's own record, the
 *      server pre-fetches the record and injects it into the first turn. The
 *      model then answers from real facts instead of guessing or falling back
 *      to its persona.
 *
 * `opts.extraTools` carries the per-device tools assembled by `chat-service`.
 */
async function runLocalAgentLoop(prompt: string, opts: CallOpts): Promise<string> {
  const tools = ((opts.extraTools ?? []) as StructuredTool[]).filter(Boolean);
  const retriever = pickRecordRetriever(tools);
  const patientQuestion = looksPatientRelated(prompt);
  // "你能看到我的资料吗" asks about the assistant's awareness, not about a single
  // fact, so it needs a confirm-and-summarise answer instead of a lookup.
  const awarenessQuestion = looksRecordAwarenessQuestion(prompt);

  // Grounded answers run cold: low temperature keeps a small model anchored to
  // the retrieved facts instead of embellishing them.
  const { model } = await buildLocalModel(
    opts,
    patientQuestion ? { temperature: LOCAL_GROUNDED_TEMPERATURE } : {},
  );
  const bound = tools.length > 0 ? model.bindTools(tools) : model;

  const system =
    composeSystemPrompt({
      soul: opts.soul,
      systemPrompt: opts.systemPrompt,
      devicePrompt: opts.devicePrompt,
      emotion: opts.emotion,
      systemHint: opts.systemHint,
    }) + buildToolContract(tools);

  const historyMessages: BaseMessage[] = compactHistory(opts.history).map((h) =>
    h.role === "assistant" ? new AIMessage(h.content) : new HumanMessage(h.content),
  );

  // Deterministic grounding: fetch the patient's record up front for questions
  // that can only be answered from it.
  let recordContext = "";
  if (retriever && patientQuestion) {
    recordContext = clampRecord(await invokeTool(retriever, prompt));
    console.log(
      `[Agent:local] pre-fetched patient record via ${retriever.name} -> ${recordContext.length} chars`,
    );
  }

  const wrapContext = (context: string): string => {
    if (!context) return "";
    const head =
      `<patient_context source="patient_wiki" trust="authoritative">\n${context}\n</patient_context>\n\n`;
    if (awarenessQuestion) {
      return (
        head +
        `[回答要求] 用户在问你是否能看到/了解他的资料。请这样回答:\n` +
        `1. **先明确肯定**——"能看到""我知道你"这类说法;\n` +
        `2. 再用上面档案里的要点**简要说出你了解他什么**(姓名、年龄、诊断等),让他确信你确实记得他;\n` +
        `3. 称呼他"你";不要出现"资料""记录""来源"等字眼;\n` +
        `4. **绝对不要**回答"我这边还没有这方面的记录"——档案就在上面。\n\n`
      );
    }
    return head;
  };

  const messages: BaseMessage[] = [
    new SystemMessage(system),
    ...historyMessages,
    new HumanMessage(
      wrapContext(recordContext) +
        `[系统时间] ${formatShanghaiDateTime()}\n${prompt}`,
    ),
  ];

  const maxSteps = Math.max(1, Number(process.env.LOCAL_AGENT_MAX_STEPS ?? "6"));
  let finalText = "";
  let toolCallsMade = 0;

  for (let step = 0; step < maxSteps; step++) {
    const ai = (await bound.invoke(messages)) as AIMessage;
    messages.push(ai);

    const calls = ai.tool_calls ?? [];
    if (calls.length === 0) {
      finalText = resolveContent(ai);
      break;
    }

    for (const call of calls) {
      const tool = tools.find((t) => t.name === call.name);
      const output = tool
        ? await invokeTool(tool, String((call.args as { query?: unknown })?.query ?? prompt))
        : `[tool error] unknown tool: ${call.name}`;
      toolCallsMade += 1;
      console.log(
        `[Agent:local] tool ${String(call.name)} -> ${output.length} chars (step ${step + 1})`,
      );
      messages.push(
        new ToolMessage({
          content: fenceToolResult(String(call.name), output),
          tool_call_id: call.id ?? String(call.name),
        }),
      );
    }
  }

  if (!finalText) {
    // Step budget exhausted while the model was still calling tools. Ask once
    // more with tools disabled so the user still gets an answer.
    const closing = await model.invoke([
      ...messages,
      new HumanMessage("（基于以上已获取的资料直接作答，不要再调用工具。）"),
    ]);
    finalText = resolveContent(closing);
  }

  // Last resort: the record was available but the model produced a generic
  // reply anyway. Re-ask on a CLEAN message array (no earlier draft to anchor
  // on) with the question restated directly beneath the facts.
  if (recordContext && patientQuestion && toolCallsMade === 0) {
    const retry = await model.invoke([
      new SystemMessage(system),
      ...historyMessages,
      new HumanMessage(
        wrapContext(recordContext) +
          `问题:${prompt}\n\n` +
          `请只依据上面的病人资料直接回答这个问题。要求:\n` +
          `- 正在和你说话的人就是这位病人,称呼"你";\n` +
          `- 资料里的姓名是病人的名字,不是你的名字(你叫 Andy);\n` +
          `- 禁止说"我是XXX";不要自我介绍;不要反问,直接回答;\n` +
          `- 资料里没有就说没有记录,不要编造;\n` +
          `- 不要出现"资料""记录""来源""工具"等字眼。`,
      ),
    ]);
    const retryText = resolveContent(retry);
    if (retryText.trim()) {
      console.log("[Agent:local] used forced grounded retry");
      finalText = retryText;
    }
  }

  return fixPatientPronouns(
    sanitizeReply(finalText),
    extractPatientName(recordContext),
    extractPatientAge(recordContext),
  );
}


async function* streamLocalOllama(
  prompt: string,
  opts: CallOpts,
): AsyncGenerator<StreamChunk, void, void> {
  // The tool loop must resolve before any text can be trusted, so yield the
  // finished answer as a single chunk. Callers already synthesise the whole
  // reply in one TTS request, so this does not change perceived latency.
  const text = await runLocalAgentLoop(prompt, opts);
  yield {
    content: text,
    toolCalls: [],
    toolResults: [],
    done: false,
    messages: [new AIMessage(text)],
  };
  yield { content: text, toolCalls: [], toolResults: [], done: true, messages: undefined };
}


function sanitizeReply(text: string): string {
  let s = text;
  s = s.replace(/`\/patients\/[^`]+`/g, "`（您的资料）`");
  s = s.replace(/（来自\s*\/patients\/[^）]+）/g, "");
  s = s.replace(/来自\s*\/patients\/[\w./\-]+/g, "根据您提供的资料");
  s = s.replace(/\/patients\/[\w.\-/]+/g, "您上传的资料");
  s = s.replace(/\braw\/uploads\/[\w.\-/]+\.md\b/g, "您上传的资料");
  s = s.replace(/\bwiki\/[\w.\-/]+\.md\b/g, "");
  return s.trim();
}

/** Single-shot agent invocation — returns just the final reply text. */
export async function callAgent(
  prompt: string,
  opts: CallOpts = {},
): Promise<string> {
  const provider = opts.provider ?? await getActiveProviderName();
  if (provider === "local") return runLocalAgentLoop(prompt, { ...opts, provider });
  const agent = await getAgent({ ...opts, provider });
  const input = buildMessages(opts.history, prompt);
  const result = await agent.invoke({ messages: input });
  return sanitizeReply(extractFinal((result.messages as unknown[]).slice(input.length)));
}

/** Single-shot with tool-call details exposed. */
export async function callAgentWithTools(
  prompt: string,
  opts: CallOpts = {},
): Promise<CallResult> {
  const agent = await getAgent(opts);
  const input = buildMessages(opts.history, prompt);
  const result = await agent.invoke({ messages: input });
  return extractCallResult((result.messages as unknown[]).slice(input.length));
}

/** Stream variant — yields a chunk per agent step. */
export async function* callAgentWithToolsStreaming(
  prompt: string,
  opts: CallOpts = {},
): AsyncGenerator<StreamChunk, void, void> {
  const provider = opts.provider ?? await getActiveProviderName();
  if (provider === "local") {
    yield* streamLocalOllama(prompt, { ...opts, provider });
    return;
  }
  const agent = await getAgent({ ...opts, provider });
  const input = buildMessages(opts.history, prompt);
  const stream = await agent.stream(
    { messages: input },
    { streamMode: "values" as const },
  );
  const iter = stream as unknown as AsyncIterable<{ messages?: unknown[] }>;
  let last: CallResult = { content: "", toolCalls: [], toolResults: [] };
  for await (const chunk of iter) {
    const messages = chunk?.messages ?? [];
    last = extractCallResult(messages.slice(input.length));
    yield { ...last, done: false, messages: messages.slice(input.length) };
  }
  yield { ...last, done: true, messages: undefined };
}

/* ============ Chat — multi-turn ============ */

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

/**
 * Stateful multi-turn conversation.
 *
 * The agent handles message accumulation internally so callers don't
 * have to thread the history through every call.
 */
export class Chat {
  private messages: ChatMessage[] = [];
  private readonly opts: CallOpts;

  public constructor(opts: CallOpts = {}) {
    this.opts = opts;
  }

  public async send(prompt: string): Promise<string> {
    this.messages.push({ role: "user", content: prompt });
    const inputLen = this.messages.length;
    const agent = await getAgent(this.opts);
    const result = await agent.invoke({
      messages: this.messages as unknown[],
    });
    this.messages = result.messages as ChatMessage[];
    return sanitizeReply(extractFinal((result.messages as unknown[]).slice(inputLen)));
  }

  public async *sendStreaming(
    prompt: string,
  ): AsyncGenerator<StreamChunk, void, void> {
    this.messages.push({ role: "user", content: prompt });
    const inputLen = this.messages.length;
    const agent = await getAgent(this.opts);
    const stream = await agent.stream(
      { messages: this.messages as unknown[] },
      { streamMode: "values" as const },
    );
    const iter = stream as unknown as AsyncIterable<{ messages?: unknown[] }>;
    let last: CallResult = { content: "", toolCalls: [], toolResults: [] };
    for await (const chunk of iter) {
      this.messages = (chunk.messages ?? []) as ChatMessage[];
      const sliced = (this.messages as unknown[]).slice(inputLen);
      last = extractCallResult(sliced);
      yield { ...last, done: false, messages: sliced };
    }
    yield { ...last, done: true, messages: undefined };
  }

  public history(): readonly ChatMessage[] {
    return this.messages;
  }

  public reset(): void {
    this.messages = [];
  }

  public get turnCount(): number {
    return this.messages.filter((m) => m.role === "user").length;
  }
}