/**
 * LLM service facade.
 *
 * Exposes a single function `chat(messages)` and hides which concrete
 * provider is in use. The provider is picked once at first use (and
 * cached on `globalThis` so HMR doesn't swap implementations mid-session).
 *
 * Selection rule:
 *   - `LLM_API_KEY` is set       → `OpenAiCompatibleProvider`
 *   - otherwise                  → `MockLlmProvider` (logs a one-line warning)
 */

import { env } from "@/lib/env";
import type { LlmMessage, LlmProvider } from "@/types/chat";
import { LlmError } from "@/types/chat";

declare global {
  var __andyLlmProvider: LlmProvider | undefined;
}

class MockLlmProvider implements LlmProvider {
  public readonly name = "mock";

  public async chat(messages: LlmMessage[]): Promise<string> {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userText = lastUser?.content ?? "";
    await new Promise((r) => setTimeout(r, 200));
    return `你好！这是开发环境的 LLM 测试回复。（mock provider · ${truncate(userText, 40)}）`;
  }

  public async *streamChat(messages: LlmMessage[]): AsyncGenerator<string, void, void> {
    const reply = await this.chat(messages);
    const words = reply.split(/(?<=\S)/);
    for (const w of words) {
      await new Promise((r) => setTimeout(r, 30));
      yield w;
    }
  }
}

class OpenAiCompatibleProvider implements LlmProvider {
  public readonly name: string;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  public constructor() {
    this.baseUrl = env.llm.baseUrl.replace(/\/+$/, "");
    this.apiKey = env.llm.apiKey;
    this.model = env.llm.model;
    this.timeoutMs = env.llm.timeoutMs;
    this.name = `openai-compatible(${new URL(this.baseUrl).host})`;
  }

  public async chat(messages: LlmMessage[]): Promise<string> {
    const controller = new AbortController();
    const timer =
      this.timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : null;

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.7,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await safeReadErrorBody(res);
        throw new LlmError(
          this.name,
          `HTTP ${res.status} ${res.statusText}: ${body}`,
        );
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string; reasoning?: string } }[];
      };
      const message = data.choices?.[0]?.message;
      // Some providers (Ollama, DeepSeek reasoning, GPT-5 family) expose the
      // chain-of-thought in `reasoning`. We only ship `content` to the device.
      const rawContent = message?.content;
      if (typeof rawContent !== "string" || rawContent.length === 0) {
        throw new LlmError(this.name, "empty or malformed response body");
      }
      return stripThinkingBlock(rawContent);
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new LlmError(this.name, `timeout after ${this.timeoutMs}ms`, err);
      }
      throw new LlmError(this.name, "request failed", err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public async *streamChat(
    messages: LlmMessage[],
  ): AsyncGenerator<string, void, void> {
    const controller = new AbortController();
    const timer =
      this.timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : null;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.7,
          stream: true,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new LlmError(this.name, `timeout after ${this.timeoutMs}ms`, err);
      }
      throw new LlmError(this.name, "request failed", err);
    }

    if (!res.ok || !res.body) {
      const body = await safeReadErrorBody(res);
      if (timer) clearTimeout(timer);
      throw new LlmError(
        this.name,
        `HTTP ${res.status} ${res.statusText}: ${body}`,
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let reasoningTail = false;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            buffer = "";
            break;
          }
          let chunk: {
            choices?: { delta?: { content?: string; reasoning_content?: string } }[];
          };
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = chunk.choices?.[0]?.delta;
          // Skip reasoning_content (DeepSeek/Qwen thinking). Only ship content.
          const reasoning = delta?.reasoning_content;
          if (reasoning) {
            // Track trailing reasoning so we can drop a leading <think>
            // if the model emits content after the reasoning block.
            reasoningTail = true;
            continue;
          }
          const content = delta?.content;
          if (typeof content === "string" && content.length > 0) {
            fullText += content;
            yield content;
            reasoningTail = false;
          }
        }
      }
      // If we never received any content and the model emitted pure reasoning,
      // strip the leading <think> block so callers don't see internal monologue.
      if (fullText.length === 0 && reasoningTail) {
        // Nothing to do — the caller will fall back to chat() if needed.
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new LlmError(this.name, `timeout after ${this.timeoutMs}ms`, err);
      }
      throw new LlmError(this.name, "stream interrupted", err);
    } finally {
      if (timer) clearTimeout(timer);
      try {
        await reader.cancel();
      } catch {}
    }
  }
}

async function safeReadErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return "<unreadable>";
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Strip a leading "thinking" block from a model reply.
 *
 * Some local / reasoning models (e.g. Qwen3.5 MLX served via Ollama)
 * emit a free-form `Thinking Process: ...` preamble before the actual
 * answer. ESP32's Serial output is small and we don't want to waste
 * bandwidth or confuse the user with internal monologue.
 */
function stripThinkingBlock(text: string): string {
  const markers = ["</think>", "</thinking>", "\n\n---"];
  for (const marker of markers) {
    const idx = text.indexOf(marker);
    if (idx !== -1) {
      return text.slice(idx + marker.length).trim();
    }
  }
  // If the entire reply starts with "Thinking Process:" without a closer,
  // try to cut at the first blank line after the first paragraph.
  if (text.startsWith("Thinking") || text.startsWith("思考")) {
    const split = text.search(/\n\s*\n/);
    if (split !== -1) {
      return text.slice(split).trim();
    }
  }
  return text;
}

function pickProvider(): LlmProvider {
  if (env.llm.apiKey.trim().length > 0) {
    return new OpenAiCompatibleProvider();
  }
  console.warn(
    "[LLM] LLM_API_KEY is empty — using MockLlmProvider. " +
      "Set LLM_API_KEY in .env.local to enable a real provider.",
  );
  return new MockLlmProvider();
}

/**
 * Return the process-wide LLM provider, constructing it on first call.
 *
 * The result is cached on `globalThis` so the same provider survives
 * Next.js HMR reloads.
 */
export function getLlmProvider(): LlmProvider {
  if (!globalThis.__andyLlmProvider) {
    globalThis.__andyLlmProvider = pickProvider();
    console.log(`[LLM] Active provider: ${globalThis.__andyLlmProvider.name}`);
  }
  return globalThis.__andyLlmProvider;
}

/**
 * Convenience wrapper: chat once with the active provider.
 *
 * The chat service is the only intended caller; raw provider access
 * exists so tests / future routes can swap in a stub.
 */
export async function chat(messages: LlmMessage[]): Promise<string> {
  return getLlmProvider().chat(messages);
}

/**
 * Convenience wrapper: stream the reply as text deltas.
 *
 * Used by the xiaozhi device pipeline so each Ollama token can be
 * forwarded into the streaming TTS WebSocket before the full reply
 * has been generated.
 */
export async function* streamChat(
  messages: LlmMessage[],
): AsyncGenerator<string, void, void> {
  yield* getLlmProvider().streamChat(messages);
}

export type { LlmProvider, LlmMessage } from "@/types/chat";
export { LlmError } from "@/types/chat";
