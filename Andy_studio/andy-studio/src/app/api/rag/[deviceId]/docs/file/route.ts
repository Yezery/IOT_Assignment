/**
 * POST /api/rag/[deviceId]/docs/file
 *
 * Multipart upload of a single .md / .txt file as a new doc.
 *
 * Fields:
 *   - file:        the file itself (required)
 *   - docId:       override the derived id (optional)
 *   - chunkSize:   override default chunk size (optional, form field as string)
 *   - chunkOverlap: override default overlap (optional)
 *
 * If `docId` is omitted we derive it from the filename without the
 * extension — so `manual.pdf.txt` becomes `manual.pdf` etc. (sanitised).
 */

import { NextResponse, type NextRequest } from "next/server";

import { addDocument } from "@/services/rag/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_FILE_BYTES = 1_048_576; // 1 MiB
const ALLOWED_EXT = new Set([".md", ".txt", ".markdown"]);

interface RouteContext {
  params: Promise<{ deviceId: string }>;
}

function deriveDocId(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  const stem = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
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
    return NextResponse.json(
      { error: "Missing `file` field" },
      { status: 400 },
    );
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
  const lower = filename.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf("."));
  if (!ALLOWED_EXT.has(ext)) {
    return NextResponse.json(
      { error: `Unsupported file extension "${ext}". Allowed: ${[...ALLOWED_EXT].join(", ")}` },
      { status: 415 },
    );
  }

  const text = await fileEntry.text();
  if (!text.trim()) {
    return NextResponse.json(
      { error: "File contains no extractable content" },
      { status: 400 },
    );
  }

  const explicitDocId = form.get("docId");
  const docId =
    typeof explicitDocId === "string" && explicitDocId.trim().length > 0
      ? explicitDocId.trim()
      : deriveDocId(filename);

  const metadata = {
    source: "upload",
    filename,
    mimeType: fileEntry.type || "text/plain",
    sizeBytes: fileEntry.size,
    uploadedAt: Date.now(),
  };

  const csRaw = form.get("chunkSize");
  const coRaw = form.get("chunkOverlap");
  const opts: { chunkSize?: number; chunkOverlap?: number; metadata: Record<string, unknown> } = {
    metadata,
  };
  if (typeof csRaw === "string") {
    const n = Number.parseInt(csRaw, 10);
    if (Number.isFinite(n) && n > 0) opts.chunkSize = n;
  }
  if (typeof coRaw === "string") {
    const n = Number.parseInt(coRaw, 10);
    if (Number.isFinite(n) && n >= 0) opts.chunkOverlap = n;
  }

  try {
    const chunkIds = await addDocument(deviceId, text, docId, opts);
    return NextResponse.json({
      deviceId,
      docId,
      filename,
      sizeBytes: fileEntry.size,
      chunkIds,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}