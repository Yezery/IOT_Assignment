import { cookies } from "next/headers";

import { db } from "@/storage/db";
import { verifyUserToken } from "@/services/xiaozhi/auth";

/**
 * Resolve the HttpOnly admin session cookie. Returns the raw JWT (or
 * undefined if the visitor has not logged in). Callers should verify the
 * token via {@link getConsoleSession} before showing privileged UI.
 */
export async function getAdminTokenFromCookies(): Promise<string | undefined> {
  const store = await cookies();
  return store.get("admin_token")?.value;
}

export type ConsoleSession =
  | { ok: true; userId: string; email: string; role: "admin" | "operator" }
  | { ok: false; reason: "missing" | "expired" | "invalid" | "deleted" };

/**
 * Read the cookie, verify the JWT signature and look up the live user. The
 * user record is re-fetched so role changes take effect immediately.
 */
export async function getConsoleSession(): Promise<ConsoleSession> {
  const token = await getAdminTokenFromCookies();
  if (!token) return { ok: false, reason: "missing" };
  const claims = await verifyUserToken(token);
  if (!claims) return { ok: false, reason: "expired" };
  const user = await db.user.findUnique({ where: { id: claims.sub } });
  if (!user) return { ok: false, reason: "deleted" };
  return { ok: true, userId: user.id, email: user.email, role: user.role };
}