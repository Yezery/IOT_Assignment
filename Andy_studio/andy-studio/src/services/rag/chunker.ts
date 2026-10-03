/**
 * Text splitter for RAG.
 *
 * Lightweight recursive character splitter — no LangChain dependency.
 * Defaults: chunk_size ≈ 400 chars, overlap 80 chars.
 *
 * For long Chinese documents you can swap to a sentence/paragraph-aware
 * splitter later; for short device docs this is plenty.
 */

export interface SplitOptions {
  chunkSize?: number;
  chunkOverlap?: number;
}

const DEFAULTS = { chunkSize: 400, chunkOverlap: 80 } as const;

/**
 * Greedy recursive split. Walks the chunk-size character window through
 * `text`, preferring boundaries at \n\n > \n > ". " > " " > "".
 */
export function splitText(
  text: string,
  opts: SplitOptions = {},
): string[] {
  const chunkSize = opts.chunkSize ?? DEFAULTS.chunkSize;
  const chunkOverlap = opts.chunkOverlap ?? DEFAULTS.chunkOverlap;
  if (text.length <= chunkSize) {
    const trimmed = text.trim();
    return trimmed ? [trimmed] : [];
  }

  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + chunkSize, text.length);
    let slice = text.slice(i, end);

    if (end < text.length) {
      slice = snapToBoundary(slice, chunkSize);
    }

    const trimmed = slice.trim();
    if (trimmed) out.push(trimmed);

    if (end >= text.length) break;
    i = Math.max(end - chunkOverlap, i + 1);
  }
  return out;
}

function snapToBoundary(slice: string, max: number): string {
  const boundaries = ["\n\n", "\n", ". ", "。 ", "? ", "! ", " "];
  for (const b of boundaries) {
    const idx = slice.lastIndexOf(b);
    if (idx > max * 0.5) {
      return slice.slice(0, idx + b.length);
    }
  }
  return slice;
}