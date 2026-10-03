import { NextResponse, type NextRequest } from "next/server";

import { listWorkspaceFiles } from "@/services/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ deviceId: string }>;
}

export async function GET(_request: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { deviceId } = await ctx.params;
  try {
    const files = await listWorkspaceFiles(deviceId);
    return NextResponse.json({ deviceId, files });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
