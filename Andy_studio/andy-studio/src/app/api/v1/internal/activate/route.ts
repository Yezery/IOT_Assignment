import { NextResponse, type NextRequest } from "next/server";
import { handleActivate, type ActivateRequest } from "@/services/xiaozhi/activation";
import { db } from "@/storage/db";
import { writeAudit } from "@/services/xiaozhi/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: ActivateRequest;
  try {
    body = (await request.json()) as ActivateRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const clientId = request.headers.get("client-id") || "";
  const deviceId = request.headers.get("device-id") || "";

  if (!body.algorithm || body.algorithm === "undefined") {
    if (clientId || deviceId) {
      const device = await db.device.findFirst({
        where: { OR: [{ clientId }, { deviceId }] },
      });
      if (device && device.status !== "active") {
        await db.device.update({
          where: { id: device.id },
          data: { status: "active", activatedAt: new Date() },
        });
        await writeAudit({
          actor: "device",
          actorId: clientId || deviceId,
          action: "activation.success",
          target: `device:${device.deviceId}`,
          payload: { method: "dev_bypass" },
        });
        return NextResponse.json({ ok: true });
      }
    }
  }

  const result = await handleActivate(body);
  if (result.status === 200) {
    return NextResponse.json({ ok: true });
  }
  if (result.status === 202) {
    return NextResponse.json({ status: "pending" }, { status: 202 });
  }
  return NextResponse.json(
    { error: "reason" in result ? result.reason : "error" },
    { status: result.status as 400 | 401 | 404 | 409 | 410 },
  );
}
