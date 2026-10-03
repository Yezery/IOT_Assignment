import type { ConvertInput, ConvertResult } from "./index";

export function convertText(input: ConvertInput, ext: string): ConvertResult {
  const decoded = input.buffer.toString("utf8").replace(/^\uFEFF/, "");
  const text = decoded.replace(/\r\n?/g, "\n").trim();

  if (!text) throw new Error(`No extractable text in "${input.filename}"`);

  if (ext === ".json") {
    return { markdown: `\`\`\`json\n${text}\n\`\`\``, converter: "json" };
  }
  if (ext === ".csv") {
    return { markdown: text, converter: "csv" };
  }
  return { markdown: text, converter: "text" };
}
