/**
 * GET /api/devices
 *
 * Returns every device persisted in Postgres along with aggregate counts.
 * Online = lastSeenAt within ONLINE_WINDOW_MS. The response shape is the
 * canonical contract for the dashboard.
 */

import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/storage/db";
import { toDeviceStatus } from "@/lib/device/device-lookup";
import { consoleToken } from "@/lib/api-auth";
import { requireUser } from "@/services/xiaozhi/auth";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireUser(consoleToken(request));
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return json({ error: status === 403 ? "forbidden" : "unauthorized" }, { status });
  }
  const rows = await db.device.findMany({
    where: { deletedAt: null },
    orderBy: { lastSeenAt: { sort: "desc", nulls: "last" } },
    take: 200,
  });

  const devices = rows.map(toDeviceStatus);
  const counts = {
    total: devices.length,
    online: devices.filter((d) => d.status === "online").length,
    offline: devices.filter((d) => d.status !== "online").length,
  };

  return NextResponse.json({ devices, counts });
}
