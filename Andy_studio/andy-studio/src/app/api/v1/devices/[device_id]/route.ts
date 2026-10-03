import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/storage/db";
import { requireUser } from "@/services/xiaozhi/auth";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ device_id: string }>;
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { device_id } = await ctx.params;
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  try {
    await requireUser(token);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return json({ error: "unauthorized" }, { status });
  }

  const numericId = /^\d+$/.test(device_id) ? BigInt(device_id) : null;
  const device = await db.device.findFirst({
    where: numericId
      ? { OR: [{ id: numericId }, { deviceId: device_id }, { clientId: device_id }] }
      : { OR: [{ deviceId: device_id }, { clientId: device_id }] },
    include: { owner: { select: { id: true, email: true } } },
  });
  if (!device) {
    return json({ error: "device not found" }, { status: 404 });
  }
  return json(device);
}
