/**
 * GET    /api/settings          — read current model settings + active provider
 * PUT    /api/settings          — patch settings / provider fields / set active
 * DELETE /api/settings          — reset settings (env defaults) + clear providers
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireConsoleAdmin } from "@/lib/api-auth";
import {
  updateSettings,
  resetSettings,
  ensureSettingsLoaded,
  type ModelSettings,
} from "@/services/ai/settings-store";
import {
  listProviders,
  getActiveProviderName,
  setActiveProvider,
  updateProvider,
  type ProviderPatch,
} from "@/services/ai/provider-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function validateSettings(patch: Partial<ModelSettings>): string | null {
  if (patch.temperature !== undefined) {
    if (typeof patch.temperature !== "number" || !Number.isFinite(patch.temperature)) {
      return "temperature must be a finite number";
    }
    if (patch.temperature < 0 || patch.temperature > 2) {
      return "temperature must be in [0, 2]";
    }
  }
  if (patch.thinking !== undefined && typeof patch.thinking !== "boolean") {
    return "thinking must be a boolean";
  }
  if (patch.maxTokens !== undefined && patch.maxTokens !== null) {
    if (typeof patch.maxTokens !== "number" || !Number.isFinite(patch.maxTokens)) {
      return "maxTokens must be a finite number or null";
    }
    if (!Number.isInteger(patch.maxTokens) || patch.maxTokens < 1) {
      return "maxTokens must be a positive integer";
    }
  }
  return null;
}

function validateProviderPatch(patch: ProviderPatch): string | null {
  if (patch.baseUrl !== undefined && typeof patch.baseUrl !== "string") {
    return "baseUrl must be a string";
  }
  if (patch.model !== undefined && (typeof patch.model !== "string" || patch.model.length === 0)) {
    return "model must be a non-empty string";
  }
  if (patch.displayName !== undefined && typeof patch.displayName !== "string") {
    return "displayName must be a string";
  }
  if (patch.apiKey !== undefined && typeof patch.apiKey !== "string") {
    return "apiKey must be a string";
  }
  if (patch.supportsThinking !== undefined && typeof patch.supportsThinking !== "boolean") {
    return "supportsThinking must be a boolean";
  }
  return null;
}

async function snapshot() {
  const settings = await ensureSettingsLoaded();
  const providers = await listProviders();
  const activeName = await getActiveProviderName();
  const active = providers.find((p) => p.name === activeName) ?? null;
  return { settings, providers, activeName, active };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireConsoleAdmin(request);
  if (!auth.ok) return auth.response;
  const { settings, providers, activeName, active } = await snapshot();
  return NextResponse.json({
    settings,
    providers: providers.map((p) => ({
      name: p.name,
      displayName: p.displayName,
      kind: p.kind,
      baseUrl: p.baseUrl,
      model: p.model,
      apiKeyHint: p.apiKeyHint,
      supportsThinking: p.supportsThinking,
      active: p.active,
    })),
    activeName,
    active,
  });
}

interface PutBody {
  settings?: Partial<ModelSettings>;
  activeProvider?: string;
  providerPatch?: { name: string } & ProviderPatch;
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const auth = await requireConsoleAdmin(request);
  if (!auth.ok) return auth.response;
  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.settings !== undefined) {
    const err = validateSettings(body.settings);
    if (err) return NextResponse.json({ error: err }, { status: 400 });
  }
  if (body.providerPatch !== undefined) {
    const err = validateProviderPatch(body.providerPatch);
    if (err) return NextResponse.json({ error: err }, { status: 400 });
  }

  try {
    if (body.settings) await updateSettings(body.settings);
    if (body.activeProvider) await setActiveProvider(body.activeProvider);
    if (body.providerPatch?.name) {
      const { name, ...patch } = body.providerPatch;
      await updateProvider(name, patch);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const { settings, providers, activeName, active } = await snapshot();
  return NextResponse.json({ settings, providers, activeName, active });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const auth = await requireConsoleAdmin(request);
  if (!auth.ok) return auth.response;
  const next = await resetSettings();
  return NextResponse.json({ settings: next });
}
