import { convertText } from "./text";
import { convertPdf } from "./pdf";
import { convertDocx } from "./docx";

export interface ConvertInput {
  buffer: Buffer;
  filename: string;
}

export interface ConvertResult {
  markdown: string;
  converter: string;
}

export const SUPPORTED_EXTENSIONS: string[] = [
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".csv",
  ".pdf",
  ".docx",
];

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json", ".csv"]);

export function extensionOf(filename: string): string {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot > 0 ? lower.slice(dot) : "";
}

export function isSupportedExtension(filename: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(extensionOf(filename));
}

export async function convertToMarkdown(input: ConvertInput): Promise<ConvertResult> {
  const ext = extensionOf(input.filename);

  if (TEXT_EXTENSIONS.has(ext)) return convertText(input, ext);
  if (ext === ".pdf") return convertPdf(input);
  if (ext === ".docx") return convertDocx(input);

  throw new Error(`Unsupported file type "${ext || input.filename}"`);
}
