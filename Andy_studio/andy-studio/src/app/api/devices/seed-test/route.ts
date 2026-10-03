/**
 * Test-only seed endpoint. Removed in production builds via
 * the absence of NODE_ENV !== 'production' guard below.
 */

import { NextResponse, type NextRequest } from "next/server";

import { __seedDeviceForTest } from "@/lib/device/store";
import type { DeviceStatus } from "@/types/device";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/devices/__seed
 *
 * Body: { deviceId, ip? }
 *
 * Marks the device online with current timestamp. For local e2e only.
 * The double-underscore prefix is the convention we use throughout
 * the codebase for non-production endpoints.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 404 });
  }
  let body: { deviceId?: unknown; ip?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.deviceId !== "string" || !body.deviceId.trim()) {
    return NextResponse.json({ error: "Missing deviceId" }, { status: 400 });
  }
  const d: DeviceStatus = {
    deviceId: body.deviceId.trim(),
    status: "online",
    lastSeen: Date.now(),
    ...(typeof body.ip === "string" ? { ip: body.ip } : {}),
  };
  __seedDeviceForTest(d);
  return NextResponse.json({ seeded: d });
}