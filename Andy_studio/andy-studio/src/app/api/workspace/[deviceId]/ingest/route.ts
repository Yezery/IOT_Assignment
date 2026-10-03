import { NextResponse, type NextRequest } from "next/server";

import { ingestRawFile } from "@/services/patient-wiki";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ deviceId: string }>;
}

export async function POST(request: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { deviceId } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON body" }, { status: 400 });
  }

  const path =
    body && typeof body === "object" ? (body as { path?: unknown }).path : undefined;
  if (typeof path !== "string" || path.trim() === "") {
    return NextResponse.json({ error: "Missing `path`" }, { status: 400 });
  }

  try {
    const result = await ingestRawFile(deviceId, path);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
