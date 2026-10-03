/**
 * DELETE /api/rag/[deviceId]  → wipe the entire device knowledge base.
 *
 * Destructive — removes every chunk AND metadata row for the device.
 * The .db file is left in place (che empty vector + metadata tables).
 */

import { NextResponse, type NextRequest } from "next/server";

import { clearDevice } from "@/services/rag/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ deviceId: string }>;
}

export async function DELETE(_request: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { deviceId } = await ctx.params;
  try {
    const removed = clearDevice(deviceId);
    return NextResponse.json({ deviceId, removed });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}