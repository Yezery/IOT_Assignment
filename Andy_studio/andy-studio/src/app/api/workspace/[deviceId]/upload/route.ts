import { NextResponse, type NextRequest } from "next/server";

import {
  convertToMarkdown,
  isSupportedExtension,
  type ConvertResult,
} from "@/services/converters";
import { writeRawFile } from "@/services/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

interface RouteContext {
  params: Promise<{ deviceId: string }>;
}

function slugify(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  const stem = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "upload";
}

export async function POST(request: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { deviceId } = await ctx.params;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data body" },
      { status: 400 },
    );
  }

  const fileEntry = form.get("file");
  if (!(fileEntry instanceof File)) {
    return NextResponse.json({ error: "Missing `file` field" }, { status: 400 });
  }
  if (fileEntry.size === 0) {
    return NextResponse.json({ error: "Uploaded file is empty" }, { status: 400 });
  }
  if (fileEntry.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: `File too large (${fileEntry.size} > ${MAX_FILE_BYTES} bytes)` },
      { status: 413 },
    );
  }

  const filename = fileEntry.name || "upload.txt";
  if (!isSupportedExtension(filename)) {
    return NextResponse.json(
      { error: `Unsupported file type "${filename}"` },
      { status: 415 },
    );
  }

  const buffer = Buffer.from(await fileEntry.arrayBuffer());

  let converted: ConvertResult;
  try {
    converted = await convertToMarkdown({ buffer, filename });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 415 },
    );
  }

  try {
    const written = await writeRawFile(
      deviceId,
      `uploads/${slugify(filename)}.md`,
      converted.markdown,
    );
    return NextResponse.json({
      deviceId,
      filename,
      converter: converted.converter,
      virtualPath: written.virtualPath,
      sizeBytes: written.size,
      markdownChars: converted.markdown.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
