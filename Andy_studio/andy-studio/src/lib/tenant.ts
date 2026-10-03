/**
 * Tenant identity helpers.
 *
 * Maps an opaque device identifier to a filesystem-safe workspace id so
 * that each device gets an isolated, deterministic directory under the
 * shared agent root.
 *
 * Historical note: workspaces used to be named with a plain
 * sanitize-and-truncate slug. A hash suffix was later added to remove
 * cross-tenant collisions. Existing directories must keep resolving to
 * their original slug or their patient data becomes unreachable, so
 * {@link safeWorkspaceId} prefers a pre-existing legacy directory and only
 * falls back to the hashed name for new tenants.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

const MAX_SLUG_LENGTH = 40;
const HASH_LENGTH = 16;
const LEGACY_MAX_ID_LENGTH = 64;
const LEGACY_FALLBACK_HASH_LENGTH = 12;

/** Root under which every patient workspace lives. */
function workspaceRootDir(): string {
  return process.env.AGENT_ROOT_DIR ?? "./work_dir";
}

/** Pre-hash naming scheme: sanitize + truncate, with a sha1 fallback. */
export function legacyWorkspaceId(deviceId: string): string {
  const cleaned = deviceId
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, LEGACY_MAX_ID_LENGTH);
  if (cleaned) return cleaned;
  return createHash("sha1")
    .update(deviceId)
    .digest("hex")
    .slice(0, LEGACY_FALLBACK_HASH_LENGTH);
}

/** Current naming scheme: readable slug plus a collision-resistant hash. */
export function hashedWorkspaceId(deviceId: string): string {
  const raw = deviceId.trim();
  if (!raw) throw new Error("deviceId must be non-empty");
  const slug =
    raw
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, MAX_SLUG_LENGTH) || "device";
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, HASH_LENGTH);
  return `${slug}--${hash}`;
}

/**
 * Resolve the on-disk workspace id for a device.
 *
 * Prefers an existing legacy directory: it predates the hash suffix and is
 * where real patient data lives. Devices that never had a legacy directory
 * get the hashed name. Results are memoised for the process lifetime; run
 * `scripts/migrate-workspace-dirs.mjs` (then restart) to adopt the hashed
 * naming scheme permanently.
 */
const resolved = new Map<string, string>();

export function safeWorkspaceId(deviceId: string): string {
  const raw = deviceId.trim();
  if (!raw) throw new Error("deviceId must be non-empty");

  const cached = resolved.get(raw);
  if (cached) return cached;

  const legacy = legacyWorkspaceId(raw);
  const hashed = hashedWorkspaceId(raw);
  const patientsDir = path.join(workspaceRootDir(), "patients");

  const chosen = existsSync(path.join(patientsDir, legacy)) ? legacy : hashed;
  resolved.set(raw, chosen);
  return chosen;
}

/** Virtual directory that holds one device's patient workspace. */
export function patientVirtualDir(deviceId: string): string {
  return `/patients/${safeWorkspaceId(deviceId)}`;
}

/** Test/HMR helper — drop the memoised workspace resolution. */
export function resetWorkspaceIdCache(): void {
  resolved.clear();
}
