/**
 * GET    /api/rag/[deviceId]/docs          → list all docs for the device
 * POST   /api/rag/[deviceId]/docs          → add a doc (JSON body)
 * DELETE /api/rag/[deviceId]/docs          → remove a doc (?docId=...)
 *
 * POST   /api/rag/[deviceId]/docs/file     → upload .md/.txt as a doc (multipart)
 *
 * The clear-all endpoint lives at /api/rag/[deviceId] (no /docs suffix)
 * to keep the verbs clean: docs = per-document, root = whole device.
 */

import { NextResponse, type NextRequest } from "next/server";

import { addDocument, deleteDocument, listDocuments } from "@/services/rag/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ deviceId: string }>;
}

export async function GET(_request: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { deviceId } = await ctx.params;
  try {
    const docs = listDocuments(deviceId);
    return NextResponse.json({ deviceId, docs });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

export async function POST(request: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { deviceId } = await ctx.params;

  let body: { text?: unknown; docId?: unknown; metadata?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json({ error: "Missing or empty `text`" }, { status: 400 });
  }
  if (typeof body.docId !== "string" || !body.docId.trim()) {
    return NextResponse.json({ error: "Missing `docId`" }, { status: 400 });
  }

  const metadata =
    body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : undefined;

  try {
    const chunkIds = await addDocument(deviceId, body.text, body.docId, { metadata });
    return NextResponse.json({ deviceId, docId: body.docId, chunkIds });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { deviceId } = await ctx.params;
  const docId = new URL(request.url).searchParams.get("docId");
  if (!docId) {
    return NextResponse.json(
      { error: "Missing `docId` query parameter" },
      { status: 400 },
    );
  }
  try {
    const removed = deleteDocument(deviceId, docId);
    return NextResponse.json({ deviceId, docId, removed });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}