/**
 * AI engine global settings.
 *
 * One row in Postgres (`model_settings`, singleton id=1) mirrored into a
 * process-local cache so the hot path (`getAgent`) can read synchronously.
 * `ensureSettingsLoaded()` hydrates the cache from the DB; `updateSettings`
 * / `resetSettings` write through to the DB.
 *
 * Surface area:
 *   - `getSettings()`          — read the cached effective settings (sync)
 *   - `ensureSettingsLoaded()` — hydrate cache from DB (idempotent)
 *   - `updateSettings(patch)`  — merge + persist + update cache
 *   - `resetSettings()`        — back to env defaults + persist
 */

import { db } from "@/storage/db";

export interface ModelSettings {
  temperature: number;
  thinking: boolean;
  maxTokens: number | null;
}

const SETTING_ID = 1;

const DEFAULTS: ModelSettings = {
  temperature: clamp01(Number.parseFloat(process.env.LLM_TEMPERATURE ?? "0.7")),
  thinking: process.env.MODEL_DISABLE_THINKING !== "true",
  maxTokens: parseOptionalInt(process.env.LLM_MAX_TOKENS),
};

interface Shape {
  current: ModelSettings;
  loaded: boolean;
  loading: Promise<void> | null;
}

declare global {
  var __andyModelSettings: Shape | undefined;
}

function store(): Shape {
  if (!globalThis.__andyModelSettings) {
    globalThis.__andyModelSettings = {
      current: { ...DEFAULTS },
      loaded: false,
      loading: null,
    };
  }
  return globalThis.__andyModelSettings;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.7;
  return Math.max(0, Math.min(2, n));
}

function parseOptionalInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalize(patch: Partial<ModelSettings>): Partial<ModelSettings> {
  return {
    ...(patch.temperature !== undefined
      ? { temperature: clamp01(patch.temperature) }
      : {}),
    ...(patch.thinking !== undefined ? { thinking: patch.thinking } : {}),
    ...(patch.maxTokens !== undefined
      ? {
          maxTokens:
            patch.maxTokens === null ? null : Math.max(1, Math.floor(patch.maxTokens)),
        }
      : {}),
  };
}

async function persist(settings: ModelSettings): Promise<void> {
  await db.modelSetting.upsert({
    where: { id: SETTING_ID },
    create: { id: SETTING_ID, ...settings },
    update: { ...settings },
  });
}

export function getSettings(): ModelSettings {
  return store().current;
}

export async function ensureSettingsLoaded(): Promise<ModelSettings> {
  const s = store();
  if (s.loaded) return s.current;
  if (!s.loading) {
    s.loading = (async () => {
      try {
        const row = await db.modelSetting.findUnique({ where: { id: SETTING_ID } });
        s.current = row
          ? {
              temperature: clamp01(row.temperature),
              thinking: row.thinking,
              maxTokens: row.maxTokens ?? null,
            }
          : { ...DEFAULTS };
      } catch (err) {
        console.error("[settings] load failed, using env defaults:", err);
        s.current = { ...DEFAULTS };
      } finally {
        s.loaded = true;
        s.loading = null;
      }
    })();
  }
  await s.loading;
  return s.current;
}

export async function updateSettings(
  patch: Partial<ModelSettings>,
): Promise<ModelSettings> {
  const s = store();
  const next: ModelSettings = { ...s.current, ...normalize(patch) };
  await persist(next);
  s.current = next;
  s.loaded = true;
  try {
    const engine = await import("./engine");
    engine.resetCache();
  } catch {
    // Engine may not be loaded yet.
  }
  return next;
}

export async function resetSettings(): Promise<ModelSettings> {
  const s = store();
  const next: ModelSettings = { ...DEFAULTS };
  await persist(next);
  s.current = next;
  s.loaded = true;
  try {
    const engine = await import("./engine");
    engine.resetCache();
  } catch {
    // Engine may not be loaded yet.
  }
  return next;
}
