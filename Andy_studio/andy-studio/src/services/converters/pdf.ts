import type { ConvertInput, ConvertResult } from "./index";

export async function convertPdf(input: ConvertInput): Promise<ConvertResult> {
  const mod = await import("pdf-parse/lib/pdf-parse.js");
  const result = await mod.default(input.buffer);
  const markdown = normalizePdfText(result.text);

  if (!markdown) throw new Error(`No extractable text in "${input.filename}"`);

  return { markdown, converter: "pdf" };
}

function normalizePdfText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    )
    .filter((paragraph) => paragraph.length > 0)
    .join("\n\n");
}
