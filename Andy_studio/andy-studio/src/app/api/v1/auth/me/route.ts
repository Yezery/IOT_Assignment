import { NextResponse, type NextRequest } from "next/server";
import { extractBearer, requireUser } from "@/services/xiaozhi/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = extractBearer(req.headers);
  try {
    const { user } = await requireUser(token);
    return NextResponse.json({
      id: user.id,
      email: user.email,
      role: user.role,
      lastLoginAt: user.lastLoginAt,
    });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return NextResponse.json({ error: "unauthorized" }, { status });
  }
}
