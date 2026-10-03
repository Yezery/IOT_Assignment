/**
 * POST /api/rag/[deviceId]/search  → run a similarity query (debug endpoint)
 *
 * Useful for inspecting what the agent's tool will see before letting
 * it answer. Same shape as the retrieval tool's return value (string).
 */

import { NextResponse, type NextRequest } from "next/server";

import { search, formatForPrompt } from "@/services/rag/retrieve";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ deviceId: string }>;
}

export async function POST(request: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { deviceId } = await ctx.params;

  let body: { query?: unknown; topK?: unknown; format?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.query !== "string" || !body.query.trim()) {
    return NextResponse.json({ error: "Missing `query`" }, { status: 400 });
  }
  const topK =
    typeof body.topK === "number" && Number.isInteger(body.topK) && body.topK > 0
      ? body.topK
      : undefined;

  try {
    const chunks = await search(deviceId, body.query, { topK });
    const includeText = body.format !== "raw";
    return NextResponse.json({
      deviceId,
      query: body.query,
      topK: topK ?? 4,
      chunks: chunks.map((c) => ({
        rowId: c.rowId,
        docId: c.docId,
        chunkIndex: c.chunkIndex,
        distance: c.distance,
        metadata: c.metadata,
        ...(includeText ? { content: c.content } : {}),
      })),
      formatted: includeText ? formatForPrompt(chunks) : undefined,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}