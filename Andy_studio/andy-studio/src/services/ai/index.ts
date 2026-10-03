/**
 * AI engine public API barrel.
 *
 * Callers (chat-service, future workflow layer) only need this file.
 */

export {
  callAgent,
  callAgentWithTools,
  callAgentWithToolsStreaming,
  Chat,
  stripThinking,
  resetCache,
  getAgent,
} from "./engine";
export type { CallResult, StreamChunk, ChatMessage } from "./engine";

export {
  SYSTEM_PROMPT,
  DEFAULT_SOUL,
  composeSystemPrompt,
  buildEmotionHint,
  buildTimeHint,
} from "./prompts";

export {
  getLLMConfig,
  assertLLMReady,
  getModelKwargsForLevel,
} from "./llm";
export type { LLMConfig } from "./llm";

export { createMCPTools } from "./mcp";

export type { ThinkingLevel, CallOpts } from "./types";