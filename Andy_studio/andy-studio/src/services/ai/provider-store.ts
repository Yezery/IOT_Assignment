/**
 * LLM provider persistence.
 *
 * Two predefined slots: "local" (Ollama, no API key) and "cloud"
 * (OpenAI-compatible upstream, key required). The active provider is
 * the one with `active = true`. Switch via `setActiveProvider(name)`.
 *
 * `apiKeyEnc` is the AES-GCM ciphertext written by `lib/crypto.ts` —
 * `loadProvider()` decrypts on read; the plaintext never leaves the
 * process. `apiKeyHint` is the last 4 chars stored at write time so
 * the UI can tell keys apart without round-tripping the cleartext.
 *
 * Cache: same pattern as `settings-store.ts` — singleton cache
 * keyed by provider name, hydrated lazily from Postgres on first read.
 */

import { db } from "@/storage/db";
import { decryptSecret, encryptSecret, hintOf } from "@/lib/crypto";

export type ProviderKind = "ollama" | "openai-compatible";

export interface ProviderConfig {
  id: number;
  name: string;
  displayName: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKeyHint: string | null;
  supportsThinking: boolean;
  active: boolean;
}

export interface ResolvedProvider extends ProviderConfig {
  /** Decrypted API key. Empty string when the slot has none (e.g. local Ollama). */
  apiKey: string;
}

interface CacheShape {
  byName: Map<string, ProviderConfig>;
  loaded: boolean;
  loading: Promise<void> | null;
  activeName: string | null;
}

declare global {
  var __andyLlmProviders: CacheShape | undefined;
}

const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434";

const DEFAULT_LOCAL_MODEL = "qwen3.5:4b-mlx";

const SEEDS: Array<Omit<ProviderConfig, "id" | "active">> = [
  {
    name: "local",
    displayName: "Local Ollama",
    kind: "ollama",
    baseUrl: DEFAULT_LOCAL_BASE_URL,
    model: DEFAULT_LOCAL_MODEL,
    apiKeyHint: null,
    supportsThinking: true,
  },
  {
    name: "cloud",
    displayName: "Cloud API",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKeyHint: null,
    supportsThinking: false,
  },
];

function shape(): CacheShape {
  if (!globalThis.__andyLlmProviders) {
    globalThis.__andyLlmProviders = {
      byName: new Map(),
      loaded: false,
      loading: null,
      activeName: null,
    };
  }
  return globalThis.__andyLlmProviders;
}

async function seedDefaults(): Promise<void> {
  for (const seed of SEEDS) {
    await db.llmProvider.upsert({
      where: { name: seed.name },
      create: { ...seed, active: seed.name === SEEDS[0].name },
      update: {},
    });
  }
}

function rowToConfig(row: {
  id: number;
  name: string;
  displayName: string;
  kind: string;
  baseUrl: string;
  model: string;
  apiKeyHint: string | null;
  supportsThinking: boolean;
  active: boolean;
}): ProviderConfig {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    kind: row.kind as ProviderKind,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKeyHint: row.apiKeyHint,
    supportsThinking: row.supportsThinking,
    active: row.active,
  };
}

export async function ensureProvidersLoaded(): Promise<CacheShape> {
  const s = shape();
  if (s.loaded) return s;
  if (!s.loading) {
    s.loading = (async () => {
      try {
        await seedDefaults();
        const rows = await db.llmProvider.findMany();
        s.byName.clear();
        for (const r of rows) s.byName.set(r.name, rowToConfig(r));
        const active = rows.find((r) => r.active);
        s.activeName = active?.name ?? null;
      } catch (err) {
        console.error("[providers] load failed, using env defaults:", err);
        for (const seed of SEEDS) {
          s.byName.set(seed.name, { id: 0, ...seed, active: seed.name === SEEDS[0].name });
        }
        s.activeName = SEEDS[0].name;
      } finally {
        s.loaded = true;
        s.loading = null;
      }
    })();
  }
  await s.loading;
  return s;
}

export async function listProviders(): Promise<ProviderConfig[]> {
  const s = await ensureProvidersLoaded();
  return Array.from(s.byName.values());
}

export async function getProvider(name: string): Promise<ProviderConfig | null> {
  const s = await ensureProvidersLoaded();
  return s.byName.get(name) ?? null;
}

export async function getActiveProviderName(): Promise<string> {
  const s = await ensureProvidersLoaded();
  return s.activeName ?? SEEDS[0].name;
}

export async function resolveProvider(name: string): Promise<ResolvedProvider | null> {
  const cfg = await getProvider(name);
  if (!cfg) return null;
  const row = await db.llmProvider.findUnique({ where: { id: cfg.id } });
  // ChatOpenAI requires a non-empty credential even for Ollama's local
  // OpenAI-compatible endpoint. Ollama ignores this placeholder unless the
  // deployment explicitly enables authentication.
  if (!row?.apiKeyEnc) return { ...cfg, apiKey: cfg.kind === "ollama" ? "ollama" : "" };
  if (cfg.kind === "ollama") {
    // Local Ollama does not need the encrypted cloud credential that may have
    // been left behind after switching providers. Avoid decryption failures
    // (for example after rotating LLM_ENCRYPTION_KEY) on the local path.
    return { ...cfg, apiKey: "ollama" };
  }
  try {
    const apiKey = decryptSecret(row.apiKeyEnc);
    return { ...cfg, apiKey };
  } catch (err) {
    // Most likely cause: LLM_ENCRYPTION_KEY changed after the key was
    // saved. Surface a clear error so the operator can re-enter the
    // key (or run a migration to re-encrypt under the new key).
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to decrypt API key for provider "${name}": ${message}. ` +
        `This usually means LLM_ENCRYPTION_KEY changed after the key was saved — re-enter the key in Settings.`,
    );
  }
}

export interface ProviderPatch {
  displayName?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  supportsThinking?: boolean;
}

export async function updateProvider(
  name: string,
  patch: ProviderPatch,
): Promise<ProviderConfig> {
  const s = await ensureProvidersLoaded();
  const data: Record<string, unknown> = {};
  if (patch.displayName !== undefined) data.displayName = patch.displayName;
  if (patch.baseUrl !== undefined) data.baseUrl = patch.baseUrl.replace(/\/+$/, "");
  if (patch.model !== undefined) data.model = patch.model;
  if (patch.supportsThinking !== undefined) data.supportsThinking = patch.supportsThinking;
  if (patch.apiKey !== undefined && patch.apiKey.length > 0) {
    data.apiKeyEnc = encryptSecret(patch.apiKey);
    data.apiKeyHint = hintOf(patch.apiKey);
  }
  const row = await db.llmProvider.update({ where: { name }, data });
  const cfg = rowToConfig(row);
  s.byName.set(cfg.name, cfg);
  // The compiled graph owns a ChatOpenAI instance, so changed endpoint/model
  // settings must take effect on the next call even when this provider remains active.
  try {
    const engine = await import("./engine");
    engine.resetCache();
  } catch {
    // Engine may not be loaded yet.
  }
  return cfg;
}

export async function setActiveProvider(name: string): Promise<ProviderConfig> {
  const s = await ensureProvidersLoaded();
  if (!s.byName.has(name)) {
    throw new Error(`Unknown LLM provider: ${name}`);
  }
  await db.$transaction([
    db.llmProvider.updateMany({ where: { active: true }, data: { active: false } }),
    db.llmProvider.update({ where: { name }, data: { active: true } }),
  ]);
  for (const cfg of s.byName.values()) cfg.active = cfg.name === name;
  s.activeName = name;
  // Drop the engine's compiled agents so the next call rebuilds with
  // the newly-active provider's model + baseURL.
  try {
    const engine = await import("./engine");
    engine.resetCache();
  } catch {
    // engine may not be loaded yet on a fresh install — ignore.
  }
  return s.byName.get(name)!;
}

/** Drop cached state — call after admin operations that bypass updateProvider. */
export function resetProvidersCache(): void {
  const s = globalThis.__andyLlmProviders;
  if (!s) return;
  s.byName.clear();
  s.loaded = false;
  s.loading = null;
  s.activeName = null;
}
