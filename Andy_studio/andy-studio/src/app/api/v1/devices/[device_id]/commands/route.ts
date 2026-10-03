import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/storage/db";
import { requireUser } from "@/services/xiaozhi/auth";
import { sendCommand, type CommandInput } from "@/services/xiaozhi/commands";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ device_id: string }>;
}

const VALID_TYPES = new Set(["system", "tts", "alert", "mcp", "notify", "goodbye"]);

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { device_id } = await ctx.params;
  const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  let userCtx;
  try {
    userCtx = await requireUser(auth);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return json({ error: "unauthorized" }, { status });
  }

  const body = (await req.json().catch(() => ({}))) as { type?: unknown; payload?: unknown };
  const type = typeof body.type === "string" ? body.type : "";
  if (!VALID_TYPES.has(type)) {
    return json({ error: `unsupported type: ${type}` }, { status: 400 });
  }

  const device = await db.device.findFirst({
    where: { OR: [{ deviceId: device_id }, { clientId: device_id }] },
  });
  if (!device) return json({ error: "device not found" }, { status: 404 });

  try {
    await sendCommand(
      device.clientId,
      { type: type as CommandInput["type"], payload: body.payload as Record<string, unknown> },
      { userId: userCtx.claims.sub, role: userCtx.claims.role },
    );
  } catch (err) {
    return json({ error: (err as Error).message }, { status: 400 });
  }

  return json({ ok: true });
}
