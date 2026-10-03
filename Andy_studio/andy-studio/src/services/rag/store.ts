/**
 * RAG store — per-device SQLite database with vec0 vector index.
 *
 * Isolation model: each ESP32 device gets its own SQLite file
 * (`./data/<device-id>.db`). Cross-device leakage is impossible because
 * the file path IS the tenant boundary — there's no shared table.
 *
 * Schema:
 *   chunks       — vec0 virtual table, one row per chunk, holds the vector
 *   chunks_meta  — regular SQLite table, holds text + doc_id + device_id
 *                  joined with `chunks.rowid`
 *
 * We split metadata out of the vec0 table because vec0 columns must be
 * numeric (vector + distance only). Joining on rowid keeps retrieval
 * fast and lets us add / drop metadata columns without re-indexing.
 *
 * Concurrency: we use better-sqlite3 (synchronous, file-local). For
 * Next.js serverless / multi-process deploys swap this module out for
 * a Postgres + pgvector backend — the public API (addDocument,
 * search) is intentionally backend-agnostic.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

/** Embedding dimension — must match the active Ollama embedding model. */
export const EMBEDDING_DIM = 4096;

/** Where per-device DB files live. Override via RAG_DATA_DIR. */
const DATA_DIR = process.env.RAG_DATA_DIR ?? "./data";

interface DeviceHandle {
  db: Database.Database;
  path: string;
}

/**
 * Resolve the sqlite-vec native binary path WITHOUT triggering Turbopack's
 * static resolver.
 *
 * We bypass `require.resolve` entirely and read the package directory
 * straight off disk, because (a) Turbopack's static analysis fails on
 * platform-conditional native modules, and (b) `sqlite-vec-*` packages
 * don't expose `./package.json` in their `exports` map.
 */
function resolveSqliteVecPath(): string {
  const { platform, arch } = process;
  const os = platform === "win32" ? "windows" : platform;
  const ext = platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so";
  const pkg = `sqlite-vec-${os}-${arch}`;

  // Search a handful of plausible anchors (works under Turbopack where
  // `__dirname` is virtualised). Returns the first existing match.
  const anchors = [
    process.cwd(),
    path.dirname(process.cwd()),
    path.dirname(path.dirname(process.cwd())),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../.."),
    path.resolve(process.cwd(), "../../.."),
  ];

  for (const anchor of anchors) {
    const candidate = path.join(anchor, "node_modules", pkg, `vec0.${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `[RAG] cannot locate ${pkg}/vec0.${ext}; checked ${anchors.join(", ")}`,
  );
}

declare global {
  var __andyRagHandles: Map<string, string> | undefined;
}

const handles: Map<string, string> =
  globalThis.__andyRagHandles ?? new Map<string, string>();
globalThis.__andyRagHandles = handles;

function devicePath(deviceId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(deviceId)) {
    throw new Error(`[RAG] invalid deviceId: "${deviceId}"`);
  }
  return path.join(DATA_DIR, `${deviceId}.db`);
}

/** Ensure the data directory exists (idempotent). */
function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Idempotently create the vec0 + metadata tables. */
function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING vec0(
      embedding float[${EMBEDDING_DIM}]
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks_meta (
      rowid INTEGER PRIMARY KEY,
      device_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_meta_device_doc ON chunks_meta(device_id, doc_id);`,
  );
}

/** Open (or reuse) the DB for a given device. */
export function getDeviceDb(deviceId: string): DeviceHandle {
  ensureDataDir();
  const dbPath = devicePath(deviceId);

  let entry = openDbCache.get(dbPath);
  if (!entry) {
    const db = new Database(dbPath);
    db.loadExtension(resolveSqliteVecPath());
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    ensureSchema(db);
    entry = { db, path: dbPath };
    openDbCache.set(dbPath, entry);
  }
  handles.set(deviceId, dbPath);
  return entry;
}

const openDbCache: Map<string, DeviceHandle> = new Map();

/** Close the DB for one device (rarely needed; mainly for tests). */
export function closeDeviceDb(deviceId: string): void {
  const dbPath = handles.get(deviceId);
  if (!dbPath) return;
  const entry = openDbCache.get(dbPath);
  if (entry) {
    entry.db.close();
    openDbCache.delete(dbPath);
  }
  handles.delete(deviceId);
}

/**
 * Run a statement against the device's DB. Most callers should use the
 * higher-level helpers in `admin.ts` / `retrieve.ts` instead.
 */
export function withDeviceDb<T>(
  deviceId: string,
  fn: (db: Database.Database) => T,
): T {
  const { db } = getDeviceDb(deviceId);
  return fn(db);
}

export type { Database };