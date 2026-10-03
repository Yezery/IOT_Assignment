/**
 * Per-device system prompt override.
 *
 * GET    /api/devices/[deviceId]/system-prompt  — read (or empty string)
 * PUT    /api/devices/[deviceId]/system-prompt  — set (empty body clears)
 * DELETE /api/devices/[deviceId]/system-prompt  — clear
 *
 * Max 4000 chars; empty / whitespace-only is treated as "clear".
 */

import { NextResponse, type NextRequest } from "next/server";

import {
  getDeviceSystemPrompt,
  setDeviceSystemPrompt,
  clearDeviceSystemPrompt,
} from "@/services/ai/device-prompt-store";
import { findDeviceRow } from "@/lib/device/device-lookup";
import { requireConsoleAdmin } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ deviceId: string }>;
}

export async function GET(
  request: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  const auth = await requireConsoleAdmin(request);
  if (!auth.ok) return auth.response;
  const { deviceId } = await ctx.params;
  if ((await findDeviceRow(deviceId)) === null) {
    return NextResponse.json({ error: "Unknown deviceId" }, { status: 404 });
  }
  return NextResponse.json({
    deviceId,
    systemPrompt: getDeviceSystemPrompt(deviceId) ?? "",
  });
}

export async function PUT(
  request: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  const auth = await requireConsoleAdmin(request);
  if (!auth.ok) return auth.response;
  const { deviceId } = await ctx.params;
  if ((await findDeviceRow(deviceId)) === null) {
    return NextResponse.json({ error: "Unknown deviceId" }, { status: 404 });
  }

  let body: { systemPrompt?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.systemPrompt !== "string") {
    return NextResponse.json(
      { error: "Missing `systemPrompt` (string required)" },
      { status: 400 },
    );
  }

  const stored = setDeviceSystemPrompt(deviceId, body.systemPrompt);
  return NextResponse.json({ deviceId, systemPrompt: stored });
}

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  const auth = await requireConsoleAdmin(request);
  if (!auth.ok) return auth.response;
  const { deviceId } = await ctx.params;
  const cleared = clearDeviceSystemPrompt(deviceId);
  return NextResponse.json({ deviceId, cleared });
}