import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/storage/db";
import { verifyPassword } from "@/services/xiaozhi/password";
import { issueUserToken } from "@/services/xiaozhi/auth";
import { writeAudit } from "@/services/xiaozhi/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LOGIN_FAIL: NextResponse = NextResponse.json(
  { error: "invalid credentials" },
  { status: 401 },
);

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { email?: unknown; password?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return LOGIN_FAIL;
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) return LOGIN_FAIL;

  const user = await db.user.findUnique({ where: { email } });
  if (!user) return LOGIN_FAIL;

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return LOGIN_FAIL;

  await db.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const token = await issueUserToken(user);

  await writeAudit({
    actor: "user",
    actorId: user.id,
    action: "auth.login",
    target: `user:${user.id}`,
    ip: req.headers.get("x-forwarded-for") ?? undefined,
    userAgent: req.headers.get("user-agent") ?? undefined,
  });

  const response = NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
    },
  });
  response.cookies.set("admin_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60,
  });
  return response;
}
