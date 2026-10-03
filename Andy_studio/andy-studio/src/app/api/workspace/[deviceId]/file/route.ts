import { NextResponse, type NextRequest } from "next/server";

import {
  readWorkspaceFile,
  WorkspaceFileNotFoundError,
} from "@/services/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ deviceId: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { deviceId } = await ctx.params;
  const relPath = request.nextUrl.searchParams.get("path");
  if (!relPath) {
    return NextResponse.json(
      { error: "Missing `path` query parameter" },
      { status: 400 },
    );
  }

  try {
    const content = await readWorkspaceFile(deviceId, relPath);
    return NextResponse.json({ deviceId, path: relPath, content });
  } catch (err) {
    const status = err instanceof WorkspaceFileNotFoundError ? 404 : 400;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status },
    );
  }
}
