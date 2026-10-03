import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/storage/db";
import { findDeviceRow } from "@/lib/device/device-lookup";
import { requireConsoleAdmin } from "@/lib/api-auth";
import { writeAudit } from "@/services/xiaozhi/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Ctx { params: Promise<{ deviceId: string }> }

const DEVICE_NOT_FOUND = NextResponse.json({ error: "Device not found" }, { status: 404 });

export async function DELETE(request: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const auth = await requireConsoleAdmin(request);
  if (!auth.ok) return auth.response;

  const { deviceId } = await ctx.params;
  const device = await findDeviceRow(deviceId);
  if (!device || device.deletedAt) return DEVICE_NOT_FOUND;

  let body: { hard?: unknown; reason?: unknown };
  try { body = await request.json(); } catch { body = {}; }

  const hard = body.hard === true;
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : undefined;

  if (hard) {
    // Hard delete cascades inside Prisma only for related rows that have an
    // explicit onDelete: Cascade relation. Manually purge chat history and
    // tokens first so we don't leave orphaned rows that bypass RLS elsewhere.
    await db.$transaction([
      db.chatMessage.deleteMany({ where: { deviceId: device.clientId } }),
      db.deviceToken.deleteMany({ where: { deviceId: device.id } }),
      db.device.delete({ where: { id: device.id } }),
    ]);
    await writeAudit({
      actor: "user", actorId: auth.userId, action: "device.hard_delete",
      target: `device:${device.clientId}`, payload: { reason },
      ip: request.headers.get("x-forwarded-for") ?? undefined,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    return NextResponse.json({ ok: true, mode: "hard", deviceId });
  }

  const deletedAt = new Date();
  await db.device.update({ where: { id: device.id }, data: { deletedAt } });
  await writeAudit({
    actor: "user", actorId: auth.userId, action: "device.soft_delete",
    target: `device:${device.clientId}`, payload: { reason },
    ip: request.headers.get("x-forwarded-for") ?? undefined,
    userAgent: request.headers.get("user-agent") ?? undefined,
  });
  return NextResponse.json({ ok: true, mode: "soft", deviceId, deletedAt: deletedAt.toISOString() });
}