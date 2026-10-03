import type { ConvertInput, ConvertResult } from "./index";

export async function convertDocx(input: ConvertInput): Promise<ConvertResult> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.convertToMarkdown({ buffer: input.buffer });
  const markdown = value.replace(/^\uFEFF/, "").trim();

  if (!markdown) throw new Error(`No extractable text in "${input.filename}"`);

  return { markdown, converter: "docx" };
}
