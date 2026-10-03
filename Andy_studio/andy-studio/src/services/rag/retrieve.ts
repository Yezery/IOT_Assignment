/**
 * RAG retrieval — top-K similarity search for one device.
 *
 * Embeds the query, runs sqlite-vec's KNN operator, joins back to
 * `chunks_meta` for text + metadata. Returns a flat array sorted by
 * ascending distance (lower = more similar).
 */

import { getDeviceDb } from "@/services/rag/store";
import { getEmbeddings } from "@/services/rag/embeddings";

export interface RetrievedChunk {
  rowId: number;
  docId: string;
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown> | null;
  distance: number;
}

export interface SearchOptions {
  topK?: number;
}

const DEFAULT_TOP_K = 4;

/**
 * Top-K similarity search for one device.
 *
 * Device isolation: the DB path itself filters by tenant; we ALSO
 * double-check `device_id` in the SQL `WHERE` clause as defence in
 * depth (theoretically unreachable from outside, but cheap insurance).
 */
export async function search(
  deviceId: string,
  query: string,
  opts: SearchOptions = {},
): Promise<RetrievedChunk[]> {
  if (!query.trim()) return [];
  const topK = Math.max(1, opts.topK ?? DEFAULT_TOP_K);

  const embedding = await getEmbeddings().embedQuery(query);
  const { db } = getDeviceDb(deviceId);

  const rows = db
    .prepare(
      `SELECT chunks.rowid AS rowid,
              distance,
              m.doc_id,
              m.chunk_index,
              m.content,
              m.metadata
         FROM chunks
         JOIN chunks_meta m ON m.rowid = chunks.rowid
        WHERE chunks.embedding MATCH ?
          AND m.device_id = ?
          AND k = ?
        ORDER BY distance`,
    )
    .all(JSON.stringify(embedding), deviceId, topK) as Array<{
      rowid: number;
      distance: number;
      doc_id: string;
      chunk_index: number;
      content: string;
      metadata: string | null;
    }>;

  return rows.map((r) => ({
    rowId: r.rowid,
    docId: r.doc_id,
    chunkIndex: r.chunk_index,
    content: r.content,
    metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
    distance: r.distance,
  }));
}

/**
 * Format retrieved chunks as a single string suitable for LLM context.
 * Includes score + source so the agent can cite.
 */
export function formatForPrompt(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "(no relevant knowledge found)";
  return chunks
    .map((c, i) => {
      const meta = c.metadata
        ? Object.entries(c.metadata)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(" ")
        : "";
      const metaSuffix = meta ? ` ${meta}` : "";
      return [
        `[${i + 1}] (doc=${c.docId}#${c.chunkIndex} score=${c.distance.toFixed(3)}${metaSuffix})`,
        c.content,
      ].join("\n");
    })
    .join("\n\n");
}