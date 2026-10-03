import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/storage/db";
import { requireUser } from "@/services/xiaozhi/auth";
import { writeAudit } from "@/services/xiaozhi/audit";
import { consoleToken } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Ctx { params: Promise<{ id: string }> }

/**
 * Operator-side activation confirmation.
 *
 * Used when an operator clicks "确认激活" on a pending row in the admin
 * console (for example: the firmware's HMAC validation step is unavailable
 * or was skipped). It atomically:
 *   - flips the device status from pending_activation → active
 *   - flips the activation row from pending → claimed
 *
 * After this the device can start using the regular WebSocket/MQTT path.
 */
export async function POST(request: NextRequest, ctx: Ctx): Promise<NextResponse> {
  let userCtx;
  try {
    userCtx = await requireUser(consoleToken(request));
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : "unauthorized" },
      { status },
    );
  }

  const { id } = await ctx.params;
  const pk = /^\d+$/.test(id) ? BigInt(id) : null;
  if (!pk) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const act = await db.activation.findUnique({
    where: { id: pk },
  });
  if (!act) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!act.deviceId) {
    return NextResponse.json({ error: "activation has no associated device" }, { status: 404 });
  }
  const device = await db.device.findUnique({ where: { id: act.deviceId } });
  if (!device) {
    return NextResponse.json({ error: "device not found" }, { status: 404 });
  }
  if (act.status !== "pending") {
    return NextResponse.json(
      { error: `cannot confirm an activation in status ${act.status}` },
      { status: 409 },
    );
  }

  await db.$transaction([
    db.device.update({
      where: { id: act.deviceId },
      data: { status: "active", activatedAt: new Date() },
    }),
    db.activation.update({
      where: { id: act.id },
      data: {
        status: "claimed",
        claimedAt: new Date(),
        claimedById: userCtx.claims.sub,
      },
    }),
  ]);

  await writeAudit({
    actor: "user",
    actorId: userCtx.claims.sub,
    action: "activation.confirm",
    target: `activation:${act.id}`,
    payload: { device: device.deviceId, code: act.code },
    ip: request.headers.get("x-forwarded-for") ?? undefined,
    userAgent: request.headers.get("user-agent") ?? undefined,
  });

  return NextResponse.json({
    ok: true,
    deviceId: device.deviceId,
    activationId: act.id.toString(),
  });
}