import { NextResponse, type NextRequest } from "next/server";
import { extractBearer, verifyUserToken } from "@/services/xiaozhi/auth";
import { writeAudit } from "@/services/xiaozhi/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = extractBearer(req.headers);
  const claims = token ? await verifyUserToken(token) : null;
  if (claims) {
    await writeAudit({
      actor: "user",
      actorId: claims.sub,
      action: "auth.logout",
      target: `user:${claims.sub}`,
    });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set("admin_token", "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax" });
  return response;
}
