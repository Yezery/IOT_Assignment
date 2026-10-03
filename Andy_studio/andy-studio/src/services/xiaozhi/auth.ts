import { SignJWT, jwtVerify } from "jose";
import { env } from "@/lib/env";
import { db } from "@/storage/db";
import type { User } from "@prisma/client";

export type UserClaims = {
  sub: string;
  scope: "user";
  role: "admin" | "operator";
  email: string;
};

const ISSUER = "andy-studio-xiaozhi";
const AUDIENCE_USER = "andy-studio-admin";

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.xiaozhi.jwtSecret);
}

export async function issueUserToken(user: User): Promise<string> {
  const expSeconds = Math.floor(Date.now() / 1000) + 60 * 60;
  return new SignJWT({
    sub: user.id,
    scope: "user" as const,
    role: user.role,
    email: user.email,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE_USER)
    .setIssuedAt()
    .setExpirationTime(expSeconds)
    .sign(secretKey());
}

export async function verifyUserToken(token: string): Promise<UserClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE_USER,
    });
    if (payload.scope !== "user") return null;
    if (
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      (payload.role !== "admin" && payload.role !== "operator")
    ) {
      return null;
    }
    return {
      sub: payload.sub,
      scope: "user",
      role: payload.role,
      email: payload.email,
    };
  } catch {
    return null;
  }
}

export async function getCurrentUser(token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const claims = await verifyUserToken(token);
  if (!claims) return null;
  return db.user.findUnique({ where: { id: claims.sub } });
}

export async function requireUser(
  token: string | undefined,
): Promise<{ user: User; claims: UserClaims }> {
  const claims = await verifyUserToken(token ?? "");
  if (!claims) throw new AuthError("unauthorized", 401);
  const user = await db.user.findUnique({ where: { id: claims.sub } });
  if (!user) throw new AuthError("unauthorized", 401);
  return { user, claims };
}

export async function requireAdmin(
  token: string | undefined,
): Promise<{ user: User; claims: UserClaims }> {
  const ctx = await requireUser(token);
  if (ctx.claims.role !== "admin") throw new AuthError("forbidden", 403);
  return ctx;
}

export class AuthError extends Error {
  public readonly status: number;
  public constructor(message: string, status: number) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export function extractBearer(input: Request | Headers | null | undefined): string | undefined {
  if (!input) return undefined;
  const headers = input instanceof Headers ? input : input.headers;
  const auth = headers.get("authorization");
  if (!auth) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m?.[1];
}
