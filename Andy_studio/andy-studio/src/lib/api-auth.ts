import { NextResponse, type NextRequest } from "next/server";

import { extractBearer, requireAdmin, requireUser } from "@/services/xiaozhi/auth";

/**
 * Resolve a console credential from either Authorization or the session cookie.
 * Browser-admin pages use `admin_token`; API clients should use Bearer tokens.
 */
export function consoleToken(request: NextRequest | Request): string | undefined {
  const bearer = extractBearer(request.headers);
  if (bearer) return bearer;
  if ("cookies" in request) {
    const cookie = request.cookies.get("admin_token")?.value;
    if (cookie) return cookie;
  }
  return undefined;
}

/**
 * Header name that the v1 device fleet sends for device-side credentials.
 * The MQTT/UDP gateway sets this; legacy fetch clients may pass it too.
 */
const DEVICE_TOKEN_HEADERS = ["authorization", "x-device-token"];

export function deviceToken(request: NextRequest | Request): string | undefined {
  for (const name of DEVICE_TOKEN_HEADERS) {
    const value = request.headers.get(name);
    if (!value) continue;
    const m = /^Bearer\s+(.+)$/i.exec(value);
    if (m) return m[1];
  }
  return undefined;
}

export async function requireConsoleAdmin(
  request: NextRequest | Request,
): Promise<{ ok: true; userId: string } | { ok: false; response: NextResponse }> {
  try {
    const ctx = await requireAdmin(consoleToken(request));
    return { ok: true, userId: ctx.user.id };
  } catch (err) {
    const status = err instanceof Error && (err as { status?: number }).status === 403 ? 403 : 401;
    return { ok: false, response: NextResponse.json({ error: status === 403 ? "forbidden" : "unauthorized" }, { status }) };
  }
}

export async function requireConsoleUser(
  request: NextRequest | Request,
): Promise<{ ok: true; userId: string; role: "admin" | "operator" } | { ok: false; response: NextResponse }> {
  try {
    const ctx = await requireUser(consoleToken(request));
    return { ok: true, userId: ctx.user.id, role: ctx.claims.role };
  } catch (err) {
    const status = err instanceof Error && (err as { status?: number }).status === 403 ? 403 : 401;
    return { ok: false, response: NextResponse.json({ error: status === 403 ? "forbidden" : "unauthorized" }, { status }) };
  }
}
