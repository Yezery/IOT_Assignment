import { NextResponse, type NextRequest } from "next/server";

import { runNightlyProfile } from "@/services/patient-wiki";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface RouteContext {
  params: Promise<{ deviceId: string }>;
}

export async function POST(request: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { deviceId } = await ctx.params;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  let date: string | undefined;
  if (body && typeof body === "object" && "date" in body) {
    const value = (body as { date?: unknown }).date;
    if (value !== undefined && value !== null) {
      if (typeof value !== "string" || !DATE_RE.test(value)) {
        return NextResponse.json(
          { error: "Invalid `date`; expected YYYY-MM-DD" },
          { status: 400 },
        );
      }
      date = value;
    }
  }

  try {
    const result = await runNightlyProfile(deviceId, date);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
