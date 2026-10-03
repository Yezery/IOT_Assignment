import type { Listen } from "./protocol";

export interface AudioBuffer {
  clientId: string;
  mode: Listen["mode"];
  frames: Buffer[];
  lastAppendAt: number;
}

declare global {
  var __xiaozhiAudio: Map<string, AudioBuffer> | undefined;
}

export function audioBuffers(): Map<string, AudioBuffer> {
  if (!globalThis.__xiaozhiAudio) globalThis.__xiaozhiAudio = new Map();
  return globalThis.__xiaozhiAudio;
}

export function pushFrame(clientId: string, frame: Buffer): void {
  const map = audioBuffers();
  let buf = map.get(clientId);
  if (!buf) {
    buf = { clientId, mode: "manual", frames: [], lastAppendAt: Date.now() };
    map.set(clientId, buf);
  }
  buf.frames.push(frame);
  buf.lastAppendAt = Date.now();
}

export function drainFrames(clientId: string): Buffer[] {
  const map = audioBuffers();
  const buf = map.get(clientId);
  if (!buf) return [];
  map.delete(clientId);
  return buf.frames;
}

export function clearFrames(clientId: string): void {
  audioBuffers().delete(clientId);
}
