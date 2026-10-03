import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/storage/db";
import { requireUser } from "@/services/xiaozhi/auth";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  try {
    await requireUser(token);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return json({ error: "unauthorized" }, { status });
  }

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const q = url.searchParams.get("q")?.trim() ?? "";
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10));
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") ?? "50", 10)));

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (q) {
    where.OR = [
      { deviceId: { contains: q, mode: "insensitive" } },
      { clientId: { contains: q, mode: "insensitive" } },
      { boardName: { contains: q, mode: "insensitive" } },
      { serialNumber: { contains: q, mode: "insensitive" } },
    ];
  }

  const [total, rows] = await Promise.all([
    db.device.count({ where }),
    db.device.findMany({
      where,
      orderBy: { lastSeenAt: { sort: "desc", nulls: "last" } },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const counts = await db.device.groupBy({ by: ["status"], _count: { _all: true } });
  const summary = { total, active: 0, pending_activation: 0, disabled: 0 } as Record<string, number>;
  for (const c of counts) summary[c.status] = c._count._all;

  return json({
    devices: rows,
    counts: summary,
    page,
    pageSize,
    total,
  });
}
