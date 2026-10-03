import { NextRequest, NextResponse } from "next/server";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

const AUDIO_DIR = join(process.cwd(), ".tmp-audio");

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;

  if (!filename || filename.includes("..") || filename.includes("/")) {
    return NextResponse.json({ error: "invalid filename" }, { status: 400 });
  }

  const filePath = join(AUDIO_DIR, filename);

  try {
    const data = await readFile(filePath);
    setTimeout(() => unlink(filePath).catch(() => {}), 10_000);

    return new NextResponse(data, {
      headers: {
        "Content-Type": "audio/ogg",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
