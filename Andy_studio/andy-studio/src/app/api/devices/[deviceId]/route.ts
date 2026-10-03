/**
 * GET /api/devices/[deviceId]
 *
 * Returns a single device record. 404 when the device id is unknown.
 *
 * In Next.js 15+ the dynamic `params` is a Promise that must be awaited.
 */

import { NextResponse } from "next/server";

import { extractBearer, requireAdmin } from "@/services/xiaozhi/auth";
import { db } from "@/storage/db";
import { findDeviceRow, toDeviceStatus } from "@/lib/device/device-lookup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ deviceId: string }>;
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const { deviceId } = await context.params;
  const row = await findDeviceRow(deviceId);
  if (!row || row.deletedAt) {
    return NextResponse.json(
      { error: "Device not found", deviceId },
      { status: 404 },
    );
  }
  return NextResponse.json(toDeviceStatus(row));
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    await requireAdmin(extractBearer(request.headers));
  } catch (err) {
    if (err instanceof Error && (err as { status?: number }).status === 403) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { deviceId } = await context.params;
  const row = await findDeviceRow(deviceId);
  if (!row || row.deletedAt) {
    return NextResponse.json(
      { error: "Device not found", deviceId },
      { status: 404 },
    );
  }

  await db.device.update({
    where: { id: row.id },
    data: { deletedAt: new Date() },
  });

  return NextResponse.json({ ok: true, deviceId, deletedAt: new Date().toISOString() });
}
