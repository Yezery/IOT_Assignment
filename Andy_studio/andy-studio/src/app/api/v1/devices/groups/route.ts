import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/storage/db";
import { requireUser, requireAdmin } from "@/services/xiaozhi/auth";
import { writeAudit } from "@/services/xiaozhi/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  try {
    await requireUser(token);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return NextResponse.json({ error: "unauthorized" }, { status });
  }
  const groups = await db.deviceGroup.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { devices: true } } },
  });
  return NextResponse.json({ groups });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  let ctx;
  try {
    ctx = await requireAdmin(token);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return NextResponse.json({ error: "forbidden" }, { status });
  }
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; parentId?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const parentId =
    typeof body.parentId === "number" || typeof body.parentId === "string"
      ? BigInt(String(body.parentId))
      : null;
  const group = await db.deviceGroup.create({
    data: { name, parentId: parentId ?? null },
  });
  await writeAudit({
    actor: "user",
    actorId: ctx.claims.sub,
    action: "group.create",
    target: `group:${group.id}`,
    payload: { name },
  });
  return NextResponse.json(group, { status: 201 });
}
