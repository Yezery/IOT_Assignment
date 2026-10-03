import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/storage/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => ({}));

  const username = body.username ?? "";
  const password = body.password ?? "";
  const clientId = body.client_id ?? "";

  if (!username || !password) {
    return NextResponse.json({ result: "deny" });
  }

  const device = await db.device.findFirst({
    where: {
      OR: [{ clientId }, { deviceId: username }],
      status: "active",
    },
  });

  if (device) {
    return NextResponse.json({ result: "allow" });
  }

  return NextResponse.json({ result: "deny" });
}
