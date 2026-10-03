/**
 * POST /api/chat
 *
 * Request: { "prompt": "你好" }
 *
 * 200 OK: { reply, duration_ms, emotion, provider }
 *   emotion is the label detected by the emotion service
 *   provider is the active LLM provider name (e.g. "Default (OpenAI-compatible)")
 *
 *   400 Bad Request          — invalid JSON / missing `prompt`
 *   405 Method Not Allowed   — anything other than POST
 *   500 Internal Server Error — LLM hard failure
 *
 * Runtime: nodejs (we want streaming-friendly fetch + access to the AI
 * engine that pulls in deepagents/langgraph).
 */

import { NextResponse, type NextRequest } from "next/server";

import { chatService } from "@/services/chat-service";
import { parseChatRequest } from "@/lib/device/chat-parse";
import { getLLMConfig } from "@/services/ai";
import { requireConsoleUser } from "@/lib/api-auth";
import { findDeviceRow } from "@/lib/device/device-lookup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireConsoleUser(request);
  if (!auth.ok) return auth.response;
  let body: { device_id?: unknown } & Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseChatRequest(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.reason }, { status: 400 });
  }

  const llm = await getLLMConfig();

  const requestedDeviceId =
    typeof body.device_id === "string" && body.device_id.trim().length > 0
      ? body.device_id.trim()
      : undefined;
  // Browser console users may use unscoped sandbox chat, but any device-bound
  // context must resolve to a real device. Device ownership policy can be
  // tightened here once operators are assigned device groups.
  const device = requestedDeviceId ? await findDeviceRow(requestedDeviceId) : null;
  if (requestedDeviceId && (!device || device.deletedAt)) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }
  const deviceId = device?.clientId;
  const outcome = await chatService.handle(parsed.request, deviceId);

  if (outcome.kind === "ok") {
    return NextResponse.json({
      ...outcome.reply,
      duration_ms: outcome.durationMs,
      emotion: outcome.emotion,
      provider: llm.displayName,
    });
  }

  if (outcome.kind === "fallback") {
    return NextResponse.json({
      ...outcome.reply,
      duration_ms: outcome.durationMs,
      emotion: "unknown",
      provider: llm.displayName,
      degraded: true,
      reason: outcome.reason,
    });
  }

  const status = outcome.reason.includes("timeout") ? 504 : 500;
  return NextResponse.json(
    { error: outcome.reason, provider: llm.displayName },
    { status },
  );
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "Use POST", accepts: "POST" },
    { status: 405, headers: { Allow: "POST" } },
  );
}