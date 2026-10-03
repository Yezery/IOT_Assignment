import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/storage/db";
import { requireUser } from "@/services/xiaozhi/auth";
import { writeAudit } from "@/services/xiaozhi/audit";
import { consoleToken } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { id } = await ctx.params;
  let userCtx;
  try {
    userCtx = await requireUser(consoleToken(req));
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : "unauthorized" },
      { status },
    );
  }

  const pk = /^\d+$/.test(id) ? BigInt(id) : null;
  if (!pk) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const act = await db.activation.findUnique({ where: { id: pk } });
  if (!act) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (act.status === "claimed") {
    return NextResponse.json({ error: "cannot revoke a claimed activation" }, { status: 409 });
  }

  await db.activation.update({
    where: { id: pk },
    data: { status: "revoked" },
  });

  await writeAudit({
    actor: "user",
    actorId: userCtx.claims.sub,
    action: "activation.revoke",
    target: `activation:${pk}`,
  });

  return NextResponse.json({ ok: true });
}
