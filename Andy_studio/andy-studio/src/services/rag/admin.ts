/**
 * RAG admin — manage a device's knowledge base.
 *
 * Public surface (all async):
 *   addDocument(deviceId, text, docId, metadata?) → row ids
 *   deleteDocument(deviceId, docId)               → row count
 *   listDocuments(deviceId)                       → doc summary[]
 *   clearDevice(deviceId)                         → row count
 *
 * All paths require the device's DB to already exist (it's created
 * lazily on first call). Cross-device operations are impossible because
 * every path resolves to `./data/<device-id>.db`.
 */

import { getDeviceDb } from "@/services/rag/store";
import { getEmbeddings } from "@/services/rag/embeddings";
import { splitText } from "@/services/rag/chunker";

export interface DocumentSummary {
  docId: string;
  chunkCount: number;
  createdAt: number;
  lastChunkAt: number;
  sampleMetadata: string | null;
}

interface AddOptions {
  /** Custom metadata attached to every chunk (e.g. source URL). */
  metadata?: Record<string, unknown>;
  /** Override default chunk size. */
  chunkSize?: number;
  /** Override default chunk overlap. */
  chunkOverlap?: number;
}

export async function addDocument(
  deviceId: string,
  text: string,
  docId: string,
  opts: AddOptions = {},
): Promise<string[]> {
  if (!text.trim()) return [];
  if (!docId.trim()) throw new Error("[RAG] docId is required");

  const chunks = splitText(text, {
    chunkSize: opts.chunkSize,
    chunkOverlap: opts.chunkOverlap,
  });
  if (chunks.length === 0) return [];

  const vectors = await getEmbeddings().embedDocuments(chunks);
  const ids: string[] = [];
  const { db } = getDeviceDb(deviceId);

  const insertChunk = db.prepare(
    "INSERT INTO chunks (embedding) VALUES (?)",
  );
  const insertMeta = db.prepare(
    "INSERT INTO chunks_meta (rowid, device_id, doc_id, chunk_index, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  const now = Date.now();
  const metaJson = opts.metadata ? JSON.stringify(opts.metadata) : null;

  const tx = db.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      const info = insertChunk.run(JSON.stringify(vectors[i]!));
      const rowid = Number(info.lastInsertRowid);
      const chunkId = `${docId}-${i}`;
      insertMeta.run(
        rowid,
        deviceId,
        docId,
        i,
        chunks[i]!,
        metaJson,
        now,
      );
      ids.push(chunkId);
    }
  });
  tx();

  return ids;
}

export function deleteDocument(deviceId: string, docId: string): number {
  const { db } = getDeviceDb(deviceId);
  const result = db
    .prepare(
      `DELETE FROM chunks_meta WHERE device_id = ? AND doc_id = ?`,
    )
    .run(deviceId, docId);
  // Vec0 rows are referenced by rowid; sqlite-vec supports rowid delete.
  db.prepare(
    `DELETE FROM chunks WHERE rowid IN (
       SELECT rowid FROM chunks_meta WHERE device_id = ? AND doc_id = ?
     )`,
  ).run(deviceId, docId);
  return Number(result.changes ?? 0);
}

export function listDocuments(deviceId: string): DocumentSummary[] {
  const { db } = getDeviceDb(deviceId);
  const rows = db
    .prepare(
      `SELECT doc_id,
              COUNT(*) AS chunk_count,
              MIN(created_at) AS first_at,
              MAX(created_at) AS last_at,
              (SELECT metadata FROM chunks_meta m2
                WHERE m2.device_id = m.device_id AND m2.doc_id = m.doc_id
                ORDER BY m2.chunk_index ASC LIMIT 1) AS sample_metadata
         FROM chunks_meta m
        WHERE device_id = ?
        GROUP BY doc_id
        ORDER BY last_at DESC`,
    )
    .all(deviceId) as Array<{
      doc_id: string;
      chunk_count: number;
      first_at: number;
      last_at: number;
      sample_metadata: string | null;
    }>;

  return rows.map((r) => ({
    docId: r.doc_id,
    chunkCount: r.chunk_count,
    createdAt: r.first_at,
    lastChunkAt: r.last_at,
    sampleMetadata: r.sample_metadata,
  }));
}

export function clearDevice(deviceId: string): number {
  const { db } = getDeviceDb(deviceId);
  const metaResult = db
    .prepare(`DELETE FROM chunks_meta WHERE device_id = ?`)
    .run(deviceId);
  db.prepare(
    `DELETE FROM chunks WHERE rowid IN (
       SELECT rowid FROM chunks_meta WHERE device_id = ?
     )`,
  ).run(deviceId);
  return Number(metaResult.changes ?? 0);
}