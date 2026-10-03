/**
 * LLM provider — runtime-resolved from the provider store.
 *
 * Two built-in slots, persisted in the `LlmProvider` table:
 *   - "local"  : Ollama (no API key, model auto-discovered via /api/tags)
 *   - "cloud"  : OpenAI-compatible upstream (API key encrypted at rest)
 *
 * The "active" row drives `getAgent()` in `engine.ts`. Switching is a
 * `setActiveProvider(name)` call; no restart required. The active
 * provider's resolved config is mirrored into `getLLMConfig()` so the
 * rest of the engine doesn't need to know about the store.
 */

import {
  getActiveProviderName,
  resolveProvider,
} from "./provider-store";

export interface LLMConfig {
  name: string;
  displayName: string;
  model: string;
  baseURL: string;
  apiKey: string;
  supportsThinking: boolean;
  defaultThinking: boolean;
}

export async function listLLMProvidersAsync(): Promise<Array<{ name: string; displayName: string; active: boolean }>> {
  const { listProviders } = await import("./provider-store");
  const rows = await listProviders();
  return rows.map((r) => ({
    name: r.name,
    displayName: r.displayName,
    active: r.active,
  }));
}

export async function getLLMConfig(name?: string): Promise<LLMConfig> {
  const providerName = name ?? (await getActiveProviderName());
  const resolved = await resolveProvider(providerName);
  if (!resolved) {
    throw new Error(`LLM provider "${providerName}" not configured`);
  }
  return {
    name: resolved.name,
    displayName: resolved.displayName,
    model: resolved.model,
    baseURL: resolved.baseUrl,
    apiKey: resolved.apiKey,
    supportsThinking: resolved.supportsThinking,
    defaultThinking: false,
  };
}

export function assertLLMReady(): void {
  // Synchronous guard used by hot paths that already trust the cache.
  // Real validation happens in getLLMConfig().
}

/**
 * Map the runtime `thinking` toggle to the model_kwargs JSON payload
 * Qwen3.5 / DeepSeek-R1 / Ollama read. We respect `LLM_THINKING_NORMAL`
 * and `LLM_THINKING_DEEP` env overrides for fine-grained control.
 */
export function getModelKwargsForThinking(
  enabled: boolean,
): Record<string, unknown> {
  if (!enabled) {
    try {
      return JSON.parse(
        process.env.LLM_THINKING_NORMAL ?? '{"reasoning_effort":"none"}',
      );
    } catch {
      return { reasoning_effort: "none" };
    }
  }
  try {
    return JSON.parse(process.env.LLM_THINKING_DEEP ?? "{}");
  } catch {
    return {};
  }
}

/** @deprecated kept for callers that still pass a level. */
export function getModelKwargsForLevel(
  level: "normal" | "deep",
): Record<string, unknown> {
  return getModelKwargsForThinking(level === "deep");
}
