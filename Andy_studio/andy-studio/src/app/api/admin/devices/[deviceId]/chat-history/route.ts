import { NextResponse, type NextRequest } from "next/server";

import { requireConsoleAdmin } from "@/lib/api-auth";
import { findDeviceRow } from "@/lib/device/device-lookup";
import { clearHistory, getDayMessages, getRecentDays } from "@/services/chat-history";
import { writeAudit } from "@/services/xiaozhi/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

interface RouteContext { params: Promise<{ deviceId: string }> }

function validDay(value: string | null): value is string {
  return value !== null && DAY_RE.test(value);
}

export async function GET(request: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const auth = await requireConsoleAdmin(request);
  if (!auth.ok) return auth.response;
  const { deviceId } = await ctx.params;
  const device = await findDeviceRow(deviceId);
  if (!device || device.deletedAt) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const day = request.nextUrl.searchParams.get("day");
  const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get("days") ?? "30"), 1), 90);
  if (day !== null && !validDay(day)) return NextResponse.json({ error: "Invalid day; expected YYYY-MM-DD" }, { status: 400 });

  const [recentDays, messages] = await Promise.all([
    getRecentDays(device.clientId, days),
    day ? getDayMessages(device.clientId, day) : Promise.resolve([]),
  ]);
  return NextResponse.json({ deviceId, storageDeviceId: device.clientId, recentDays, day, messages });
}

export async function DELETE(request: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const auth = await requireConsoleAdmin(request);
  if (!auth.ok) return auth.response;
  const { deviceId } = await ctx.params;
  const device = await findDeviceRow(deviceId);
  if (!device || device.deletedAt) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  let body: { day?: unknown; from?: unknown; to?: unknown; confirm?: unknown; reason?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (body.confirm !== true) return NextResponse.json({ error: "Set confirm: true to delete chat history" }, { status: 400 });
  const day = typeof body.day === "string" ? body.day : undefined;
  const from = typeof body.from === "string" ? body.from : undefined;
  const to = typeof body.to === "string" ? body.to : undefined;
  if ((day && !DAY_RE.test(day)) || (from && !DAY_RE.test(from)) || (to && !DAY_RE.test(to)) || (from && to && from > to)) {
    return NextResponse.json({ error: "Invalid deletion date range" }, { status: 400 });
  }

  const removed = await clearHistory(device.clientId, { day, from, to });
  await writeAudit({
    actor: "user", actorId: auth.userId, action: "chat_history.delete", target: `device:${device.clientId}`,
    payload: { removed, ...(day ? { day } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), reason: typeof body.reason === "string" ? body.reason.slice(0, 300) : undefined },
    ip: request.headers.get("x-forwarded-for") ?? undefined, userAgent: request.headers.get("user-agent") ?? undefined,
  });
  return NextResponse.json({ ok: true, deviceId, removed, warning: "Only database chat rows were deleted. Existing raw/wiki derived summaries require a separate governed purge workflow." });
}
