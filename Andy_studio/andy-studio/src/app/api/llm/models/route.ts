/**
 * GET /api/llm/models?baseUrl=...&apiKey=...
 *
 * Returns `{models: [{name, size, modified}]}` from an Ollama-compatible
 * `/api/tags` endpoint. Used by the Settings UI to populate the model
 * dropdown after the user enters the baseUrl.
 *
 * Non-Ollama providers (OpenAI / DeepSeek / etc.) don't expose a model
 * list — callers pass `kind=openai-compatible` and we return an empty
 * list, letting the user type the model name manually.
 */

import { type NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface OllamaModel {
  name: string;
  size?: number;
  modified_at?: string;
}

interface OllamaTagsResponse {
  models?: OllamaModel[];
}

export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const baseUrl = (url.searchParams.get("baseUrl") ?? "").replace(/\/+$/, "");
  const apiKey = url.searchParams.get("apiKey") ?? "";
  const kind = url.searchParams.get("kind") ?? "ollama";

  if (!baseUrl) {
    return Response.json({ models: [], error: "baseUrl required" }, { status: 400 });
  }

  if (kind !== "ollama") {
    return Response.json({ models: [] });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const tagsUrl = baseUrl.endsWith("/v1")
      ? `${baseUrl}/../api/tags`.replace(/\/+$/, "")
      : `${baseUrl}/api/tags`;
    const res = await fetch(tagsUrl, { headers, signal: controller.signal });
    if (!res.ok) {
      return Response.json({
        models: [],
        error: `Ollama /api/tags returned HTTP ${res.status}`,
      }, { status: 200 });
    }
    const data = (await res.json()) as OllamaTagsResponse;
    const models = (data.models ?? []).map((m) => ({
      name: m.name,
      size: m.size ?? null,
      modifiedAt: m.modified_at ?? null,
    }));
    return Response.json({ models });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ models: [], error: message }, { status: 200 });
  } finally {
    clearTimeout(timer);
  }
}
