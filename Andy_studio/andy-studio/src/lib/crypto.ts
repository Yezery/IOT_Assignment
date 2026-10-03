/**
 * Symmetric encryption helpers used to store LLM API keys at rest.
 *
 * The key material lives in `LLM_ENCRYPTION_KEY` (32-byte base64). Without
 * it the server refuses to start, so misconfiguration is loud rather
 * than silent.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function loadKey(): Buffer {
  const raw = process.env.LLM_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "LLM_ENCRYPTION_KEY is not set — refusing to encrypt/decrypt secrets",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      `LLM_ENCRYPTION_KEY must decode to 32 bytes, got ${buf.length}`,
    );
  }
  return buf;
}

export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("Encrypted payload is too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, loadKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf-8");
}

/** Last 4 characters of a secret, safe to surface in the UI. */
export function hintOf(plaintext: string): string {
  return plaintext.length <= 4 ? plaintext : plaintext.slice(-4);
}
