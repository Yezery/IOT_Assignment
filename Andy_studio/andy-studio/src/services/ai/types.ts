/**
 * Cross-cutting types for the AI engine.
 *
 * Kept minimal — only what is genuinely shared across engine/prompts/llm/mcp.
 */

export type ThinkingLevel = "normal" | "deep";

/** Options accepted by `callAgent()` and `Chat.send()`. */
export interface CallOpts {
  /** Fully override the system prompt (you compose SOUL + RULES yourself). */
  systemPrompt?: string;
  /** Override only the SOUL layer; RULES still use the default. */
  soul?: string;
  /**
   * Per-device SOUL override. Takes priority over `soul` and the
   * env-var default but loses to `systemPrompt`. When set, this becomes
   * the entire SOUL section (RULES still come from the default).
   */
  devicePrompt?: string;
  temperature?: number;
  thinking?: boolean;
  maxTokens?: number;
  thinkingLevel?: ThinkingLevel;
  provider?: string;
  /**
   * Detected user emotion (label from EmotionService). When provided, it is
   * appended to the composed system prompt so the agent can adapt its tone.
   */
  emotion?: string;
  /**
   * Extra tools to register on this agent instance, in addition to the
   * defaults (MCP tools). Used by the chat service to inject per-device
   * RAG retrieval. May be empty / omitted.
   */
  extraTools?: unknown[];
  /**
   * Tenant scope (raw device id). When set, the engine restricts the
   * agent's filesystem permissions to that device's virtual workspace.
   */
  scope?: string;
  /**
   * Extra system-prompt fragment appended after SOUL + RULES + emotion +
   * time hint. Used for per-call context such as RAG retrieval hints.
   */
  systemHint?: string;
  /** Prior turns replayed before the current prompt. */
  history?: { role: "user" | "assistant"; content: string }[];
}