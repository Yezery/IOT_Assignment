/**
 * Device alias API.
 *
 * GET    /api/devices/[deviceId]/alias  → read display name (or null)
 * PATCH  /api/devices/[deviceId]/alias  → set display name (body: { displayName })
 * DELETE /api/devices/[deviceId]/alias  → clear display name
 *
 * Body validation rules:
 *   - displayName: 1–64 chars after trim; empty string clears the alias
 */

import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/storage/db";
import { findDeviceRow } from "@/lib/device/device-lookup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_LEN = 64;

interface RouteContext {
  params: Promise<{ deviceId: string }>;
}

export async function GET(
  _request: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  const { deviceId } = await ctx.params;
  const device = await findDeviceRow(deviceId);
  if (!device) {
    return NextResponse.json({ error: "Unknown deviceId" }, { status: 404 });
  }
  return NextResponse.json({ deviceId, displayName: device.alias ?? null });
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  const { deviceId } = await ctx.params;
  const device = await findDeviceRow(deviceId);
  if (!device) {
    return NextResponse.json({ error: "Unknown deviceId" }, { status: 404 });
  }

  let body: { displayName?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.displayName !== "string") {
    return NextResponse.json(
      { error: "Missing or invalid `displayName` (string required)" },
      { status: 400 },
    );
  }

  const trimmed = body.displayName.trim();
  if (trimmed.length > MAX_LEN) {
    return NextResponse.json(
      { error: `displayName too long (max ${MAX_LEN} chars)` },
      { status: 400 },
    );
  }

  const alias = trimmed.length > 0 ? trimmed : null;
  await db.device.update({ where: { id: device.id }, data: { alias } });
  return NextResponse.json({ deviceId, displayName: alias });
}

export async function DELETE(
  _request: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  const { deviceId } = await ctx.params;
  const device = await findDeviceRow(deviceId);
  if (!device) {
    return NextResponse.json({ error: "Unknown deviceId" }, { status: 404 });
  }
  await db.device.update({ where: { id: device.id }, data: { alias: null } });
  return NextResponse.json({ deviceId, cleared: true });
}
