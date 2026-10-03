/**
 * Chat / LLM-related types shared by MQTT handlers, services and ESP32 firmware.
 *
 * Kept dependency-free so the same shapes can be hand-serialized as JSON
 * between server and device.
 */

/**
 * Outbound chat request published by ESP32 → `device/{id}/chat/request`.
 *
 * Wire format:
 *
 *   { "prompt": "你好" }
 */
export interface ChatRequestPayload {
  prompt: string;
}

/**
 * Inbound chat response published by server → `device/{id}/chat/reply`.
 *
 *   { "reply": "你好！有什么需要帮助的吗？" }
 */
export interface ChatResponsePayload {
  reply: string;
}

/** Result of validating a raw MQTT chat request payload. */
export type ParsedChatRequest =
  | { ok: true; request: ChatRequestPayload }
  | { ok: false; reason: string };

/** One message in the LLM conversation history. */
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Provider-agnostic LLM contract.
 *
 * Concrete implementations live in `src/services/llm-service.ts`. The
 * factory selects the provider at runtime based on `LLM_API_KEY`.
 *
 * Implementations MUST guarantee:
 *   - `chat()` returns the complete assistant reply (after stripping any
 *     `<think>...</think>` block).
 *   - `streamChat()` yields the same final text incrementally, one delta
 *     at a time. The concatenation of all yielded strings equals the
 *     reply that `chat()` would have returned (modulo timing of final
 *     flush).
 */
export interface LlmProvider {
  readonly name: string;
  chat(messages: LlmMessage[]): Promise<string>;
  /** Stream the assistant reply as a sequence of text deltas. */
  streamChat(messages: LlmMessage[]): AsyncGenerator<string, void, void>;
}

/** Error raised by an LLM provider; distinguishes infra failures from API errors. */
export class LlmError extends Error {
  public readonly provider: string;
  public readonly cause?: unknown;

  public constructor(
    provider: string,
    message: string,
    cause?: unknown,
  ) {
    super(`[${provider}] ${message}`);
    this.name = "LlmError";
    this.provider = provider;
    this.cause = cause;
  }
}
