import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/storage/db";
import { requireAdmin } from "@/services/xiaozhi/auth";
import { writeAudit } from "@/services/xiaozhi/audit";
import { consoleToken } from "@/lib/api-auth";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BATCH_LIMIT = 200;

interface BatchInput {
  ids?: unknown;
  reason?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Prefer Bearer (v1 client) but accept the HttpOnly console cookie so the
  // admin UI does not need to hand the JWT to JavaScript.
  const bearer = consoleToken(request) ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  let ctx;
  try {
    ctx = await requireAdmin(bearer);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return json({ error: status === 403 ? "forbidden" : "unauthorized" }, { status });
  }

  let body: BatchInput;
  try {
    body = (await request.json()) as BatchInput;
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = Array.isArray(body.ids) ? body.ids : null;
  if (!raw) return json({ error: "ids (string[]) required" }, { status: 400 });
  const ids = Array.from(
    new Set(
      raw
        .filter((v): v is string => typeof v === "string" && /^\d+$/.test(v))
        .map((v) => BigInt(v)),
    ),
  );
  if (ids.length === 0) return json({ error: "no valid ids" }, { status: 400 });
  if (ids.length > BATCH_LIMIT) {
    return json({ error: `too many ids (max ${BATCH_LIMIT})` }, { status: 400 });
  }

  const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : undefined;

  const candidates = await db.activation.findMany({
    where: { id: { in: ids } },
    select: { id: true, code: true, status: true },
  });

  const eligible = candidates.filter((c) => c.status !== "claimed" && c.status !== "revoked");
  const skipped: { id: string; reason: string; status: string }[] = candidates
    .filter((c) => c.status === "claimed" || c.status === "revoked")
    .map((c) => ({
      id: c.id.toString(),
      reason: c.status === "claimed" ? "already claimed" : "already revoked",
      status: c.status,
    }));

  let revokedCount = 0;
  if (eligible.length > 0) {
    const result = await db.activation.updateMany({
      where: { id: { in: eligible.map((c) => c.id) } },
      data: { status: "revoked" },
    });
    revokedCount = result.count;
  }

  await writeAudit({
    actor: "user",
    actorId: ctx.claims.sub,
    action: "activation.bulk_revoke",
    target: `activation:bulk:${revokedCount}`,
    payload: {
      requested: ids.length,
      revoked: revokedCount,
      skipped: skipped.length,
      reason,
    },
  });

  return json({
    ok: true,
    requested: ids.length,
    revoked: revokedCount,
    skipped,
  });
}