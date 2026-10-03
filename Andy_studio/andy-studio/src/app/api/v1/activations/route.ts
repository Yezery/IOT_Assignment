import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { db } from "@/storage/db";
import { requireUser } from "@/services/xiaozhi/auth";
import { writeAudit } from "@/services/xiaozhi/audit";
import { env } from "@/lib/env";
import { consoleToken } from "@/lib/api-auth";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function makeCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i === 3) out += "-";
  }
  return out;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = consoleToken(req);
  try {
    await requireUser(token);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return json({ error: "unauthorized" }, { status });
  }
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const where = status ? { status: status as "pending" | "claimed" | "expired" | "revoked" } : {};
  const rows = await db.activation.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return json({ activations: rows });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Accept Bearer from API clients, the HttpOnly `admin_token` cookie from the
  // admin console, and the legacy X-Device-Token header used by the device fleet.
  // Both `admin` and `operator` roles can mint activation codes — they are not
  // destructive; only revoke/destroy actions stay admin-only.
  const token = consoleToken(req);
  let ctx;
  try {
    const { requireUser } = await import("@/services/xiaozhi/auth");
    ctx = await requireUser(token);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return json({ error: status === 403 ? "forbidden" : "unauthorized" }, { status });
  }

  const body = (await req.json().catch(() => ({}))) as {
    deviceId?: unknown;
    expiresIn?: unknown;
    message?: unknown;
  };
  const devicePk = typeof body.deviceId === "string" && /^\d+$/.test(body.deviceId) ? BigInt(body.deviceId) : null;
  if (!devicePk) {
    return json({ error: "deviceId (numeric) required" }, { status: 400 });
  }
  const device = await db.device.findUnique({ where: { id: devicePk } });
  if (!device) return json({ error: "device not found" }, { status: 404 });

  const ttlMin =
    typeof body.expiresIn === "number" && body.expiresIn > 0 && body.expiresIn <= 60 * 24
      ? body.expiresIn
      : env.xiaozhi.activationTtlMin;
  const expiresAt = new Date(Date.now() + ttlMin * 60_000);

  const code = makeCode();
  const challenge = randomBytes(32).toString("base64");
  const message =
    typeof body.message === "string" && body.message.length > 0
      ? body.message
      : "Use the Andy Studio admin console to bind this device.";

  const created = await db.activation.create({
    data: {
      code,
      deviceId: devicePk,
      status: "pending",
      challenge,
      message,
      createdById: ctx.claims.sub,
      expiresAt,
    },
  });

  await db.device.update({
    where: { id: devicePk },
    data: { activationId: created.id, status: "pending_activation" },
  });

  await writeAudit({
    actor: "user",
    actorId: ctx.claims.sub,
    action: "activation.create",
    target: `activation:${created.id}`,
    payload: { code, deviceId: device.deviceId, ttlMin },
  });

  return json(
    {
      id: created.id,
      code: created.code,
      challenge: created.challenge,
      expiresAt: created.expiresAt,
      message: created.message,
    },
    { status: 201 },
  );
}
