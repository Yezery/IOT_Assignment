/**
 * ASR provider — Doubao streaming WebSocket protocol.
 *
 * Supports two modes:
 *  1. Streaming: Open a WebSocket, stream audio frames in real-time, get partial results.
 *  2. Batch (legacy): Collect all frames, convert to WAV, upload at once.
 *
 * Streaming mode is used for real-time text display on the device.
 *
 * Protocol: gzip-compressed binary frames over WebSocket
 *   1. Connect with X-Api-Key auth
 *   2. Send init request (msgType=1, gzip JSON)
 *   3. Stream audio frames (msgType=2, gzip PCM chunks)
 *   4. Send last frame (msgType=2, flags=NEG_WITH_SEQUENCE)
 *   5. Parse binary responses (header + seq + JSON length + JSON)
 */

import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { env } from "@/lib/env";

// ── Protocol constants ─────────────────────────────────────────────────────
const PROTOCOL_VERSION = 0x01;
const HEADER_SIZE = 0x01; // 1 × 4 bytes

// Message types
const CLIENT_FULL_REQUEST = 0x01;
const CLIENT_AUDIO_ONLY = 0x02;
const SERVER_FULL_RESPONSE = 0x09;
const SERVER_ERROR = 0x0f;

// Flags
const POS_SEQUENCE = 0x01;
const NEG_WITH_SEQUENCE = 0x03;

// Serialization
const JSON_SERIAL = 0x01;
const NO_SERIAL = 0x00;

// Compression
const GZIP = 0x01;

// ── Types ──────────────────────────────────────────────────────────────────
export type AsrRequest = {
  opusFrames: Buffer[];
};

export type AsrResult = {
  text: string;
  utterances?: Array<{
    text: string;
    start_time: number;
    end_time: number;
    definite?: boolean;
  }>;
};

export type AsrPartialResult = {
  text: string;
  isFinal: boolean;
};

// ── Binary helpers ─────────────────────────────────────────────────────────
function buildHeader(
  messageType: number,
  flags: number,
  serialization: number,
  compression: number,
): Buffer {
  const h = Buffer.alloc(4);
  h[0] = (PROTOCOL_VERSION << 4) | HEADER_SIZE;
  h[1] = (messageType << 4) | flags;
  h[2] = (serialization << 4) | compression;
  h[3] = 0x00;
  return h;
}

function buildInitPayload(): Record<string, unknown> {
  return {
    user: { uid: "andy-studio-server" },
    audio: {
      format: "pcm",
      codec: "raw",
      rate: 16000,
      bits: 16,
      channel: 1,
    },
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      show_utterances: true,
      result_type: "full",
    },
  };
}

function buildInitFrame(seq: number): Buffer {
  const payload = buildInitPayload();
  const json = Buffer.from(JSON.stringify(payload), "utf-8");
  const compressed = gzipSync(json);
  const header = buildHeader(CLIENT_FULL_REQUEST, POS_SEQUENCE, JSON_SERIAL, GZIP);
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(seq);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(compressed.length);
  return Buffer.concat([header, seqBuf, lenBuf, compressed]);
}

function buildAudioFrame(seq: number, pcmChunk: Buffer, isLast: boolean): Buffer {
  const flags = isLast ? NEG_WITH_SEQUENCE : POS_SEQUENCE;
  const actualSeq = isLast ? -Math.abs(seq) : seq;
  const compressed = gzipSync(pcmChunk);
  const header = buildHeader(CLIENT_AUDIO_ONLY, flags, NO_SERIAL, GZIP);
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(actualSeq);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(compressed.length);
  return Buffer.concat([header, seqBuf, lenBuf, compressed]);
}

function parseResponse(buf: Buffer): AsrPartialResult {
  if (buf.length < 4) return { text: "", isFinal: false };

  const headerSize = (buf[0] & 0x0f) * 4;
  const messageType = buf[1] >> 4;
  const flags = buf[1] & 0x0f;
  const serialization = buf[2] >> 4;
  const compression = buf[2] & 0x0f;

  let payload = buf.subarray(headerSize);

  // Skip sequence if present
  if (flags & 0x01) {
    payload = payload.subarray(4);
  }

  // Check if last
  const isFinal = !!(flags & 0x02);

  // Error response
  if (messageType === SERVER_ERROR) {
    const code = payload.readInt32BE(0);
    const msgLen = payload.readInt32BE(4);
    const msg = payload.subarray(8, 8 + msgLen).toString("utf-8");
    console.error(`[ASR] server error code=${code}: ${msg}`);
    return { text: "", isFinal: true };
  }

  // Full response
  if (messageType === SERVER_FULL_RESPONSE && payload.length >= 4) {
    const payloadLen = payload.readUInt32BE(0);
    payload = payload.subarray(4, 4 + payloadLen);
  }

  if (payload.length === 0) return { text: "", isFinal };

  // Decompress
  let decompressed = payload;
  if (compression === GZIP) {
    try {
      decompressed = Buffer.from(gunzipSync(payload));
    } catch {
      return { text: "", isFinal };
    }
  }

  // Parse JSON
  if (serialization === JSON_SERIAL) {
    try {
      const data = JSON.parse(decompressed.toString("utf-8"));
      const result = data?.result;
      if (result?.text) {
        return { text: result.text, isFinal };
      }
      // Check utterances for partial text
      if (result?.utterances?.length > 0) {
        const text = result.utterances
          .map((u: { text: string }) => u.text)
          .join("");
        return { text, isFinal };
      }
    } catch {
      // ignore parse errors
    }
  }

  return { text: "", isFinal };
}

// ── Opus → PCM conversion ─────────────────────────────────────────────────
function opusToPcm(opusFrames: Buffer[]): Promise<Buffer> {
  if (opusFrames.length === 0) return Promise.resolve(Buffer.alloc(0));

  return new Promise((resolve, reject) => {
    // Build Ogg/Opus container from individual Opus packets
    const opusHead = Buffer.from([
      0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64,
      0x01, 0x01, 0x01, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x00, 0x00,
    ]);
    const opusTags = Buffer.from([
      0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73,
      0x0c, 0x00, 0x00, 0x00,
      0x4c, 0x61, 0x76, 0x66, 0x36, 0x33, 0x2e, 0x31, 0x2e, 0x30, 0x31,
    ]);

    function oggCrc(data: Buffer): number {
      const table = (() => {
        const t = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
          let r = i << 24;
          for (let j = 0; j < 8; j++) {
            r = (r & 0x80000000) !== 0 ? ((r << 1) ^ 0x04c11db7) : (r << 1);
          }
          t[i] = r >>> 0;
        }
        return t;
      })();
      let crc = 0;
      for (let i = 0; i < data.length; i++) {
        crc = ((crc << 8) ^ table[((crc >>> 24) ^ data[i]) & 0xff]) >>> 0;
      }
      return crc;
    }

    function oggPage(type: number, granule: number, packets: Buffer[]): Buffer {
      const segCount = packets.length;
      const header = Buffer.alloc(27);
      header.write("OggS", 0);
      header[4] = 0;
      header[5] = type;
      header.writeBigUInt64LE(BigInt(granule), 6);
      header.writeUInt32LE(0xdeadbeef, 14);
      header.writeUInt32LE(0, 18);
      header[26] = segCount;
      const segTable = Buffer.alloc(segCount);
      for (let i = 0; i < segCount; i++)
        segTable[i] = Math.min(packets[i].length, 255);
      const pre = Buffer.concat([header, segTable, ...packets]);
      const crc = oggCrc(pre);
      header.writeUInt32LE(crc, 22);
      return Buffer.concat([header, segTable, ...packets]);
    }

    const ogg = Buffer.concat([
      oggPage(0x02, 0, [opusHead]),
      oggPage(0x04, 0, [opusTags]),
      oggPage(0x00, opusFrames.length * 960, opusFrames),
    ]);

    const proc = spawn(
      env.xiaozhi.ffmpegPath,
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "ogg", "-i", "pipe:0",
        "-ac", "1", "-ar", "16000",
        "-f", "s16le", "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const out: Buffer[] = [];
    const err: string[] = [];
    proc.stdout.on("data", (b: Buffer) => out.push(b));
    proc.stderr.on("data", (s) => err.push(s.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0)
        reject(new Error(`ffmpeg exit ${code}: ${err.join("").slice(0, 400)}`));
      else resolve(Buffer.concat(out));
    });
    proc.stdin.write(ogg);
    proc.stdin.end();
  });
}

// ── Streaming ASR Session ──────────────────────────────────────────────────
export class StreamingASRSession {
  private ws: WebSocket | null = null;
  private seq = 0;
  private opusBuffer: Buffer[] = [];
  private pcmChunkSize = 3200; // 100ms at 16kHz 16bit mono
  private resolving = false;
  private pendingResolve: (() => void) | null = null;
  private lastResult = "";
  private finished = false;
  private onPartialResult: ((text: string) => void) | null = null;
  private onAudioLevel: ((rms: number) => void) | null = null;
  private flushedOnce = false;

  setOnPartialResult(callback: (text: string) => void): void {
    this.onPartialResult = callback;
  }

  setOnAudioLevel(callback: (rms: number) => void): void {
    this.onAudioLevel = callback;
  }

  /**
   * Open WebSocket connection and send init request.
   */
  async start(): Promise<void> {
    const apiKey = env.xiaozhi.doubao.apiKey;
    if (!apiKey) throw new Error("[ASR] DOUBAO_API_KEY must be set");

    const resourceId = "volc.seedasr.sauc.duration";
    const wsUrl = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";

    this.ws = new WebSocket(wsUrl, {
      headers: {
        "X-Api-Key": apiKey,
        "X-Api-Resource-Id": resourceId,
        "X-Api-Connect-Id": randomUUID(),
      },
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("ASR WS connect timeout")),
        15000,
      );
      this.ws!.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws!.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Send init request
    this.seq = 1;
    const initFrame = buildInitFrame(this.seq);
    this.ws!.send(initFrame);

    // Wait for init response
    await this.waitForInitResponse();
    console.log("[ASR] streaming session started");
  }

  private waitForInitResponse(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("ASR init response timeout")),
        10000,
      );
      this.ws!.once("message", (data: Buffer) => {
        clearTimeout(timer);
        const result = parseResponse(Buffer.from(data));
        if (result.isFinal && !result.text) {
          // Init response with no text is expected
          resolve();
        } else {
          // Got a result, that's fine too
          this.lastResult = result.text;
          resolve();
        }
      });
    });
  }

  /**
   * Add an Opus frame to the streaming session.
   * Frames are buffered and sent in batches for efficiency.
   */
  async addFrame(opusFrame: Buffer): Promise<void> {
    if (this.finished || !this.ws) return;

    this.opusBuffer.push(opusFrame);

    // Flush the first frame immediately to start upstream ASR sooner; after
    // that use a small batch to limit conversion and WebSocket overhead.
    const threshold = this.flushedOnce ? 2 : 1;
    if (this.opusBuffer.length >= threshold && !this.resolving) {
      await this.flushBuffer();
    }
  }

  private async flushBuffer(): Promise<void> {
    if (this.opusBuffer.length === 0 || !this.ws) return;

    this.resolving = true;
    const frames = this.opusBuffer.splice(0);

    try {
      const pcm = await opusToPcm(frames);
      if (!this.flushedOnce) {
        this.flushedOnce = true;
        console.log(`[ASR] first flush: ${frames.length} opus frames → ${pcm.length}B pcm`);
      }
      this.reportAudioLevel(pcm);

      // Send PCM in chunks
      for (let offset = 0; offset < pcm.length; offset += this.pcmChunkSize) {
        const chunk = pcm.subarray(
          offset,
          Math.min(offset + this.pcmChunkSize, pcm.length),
        );
        this.seq++;
        const frame = buildAudioFrame(this.seq, chunk, false);
        this.ws.send(frame);

        // Try to receive partial result (non-blocking)
        await this.tryReceiveResult();
      }
    } catch (err) {
      console.error("[ASR] flush error:", err);
    }

    this.resolving = false;
  }

  private reportAudioLevel(pcm: Buffer): void {
    if (!this.onAudioLevel || pcm.length < 2) return;
    const sampleCount = Math.floor(pcm.length / 2);
    let sumSquares = 0;
    for (let i = 0; i < sampleCount; i++) {
      const sample = pcm.readInt16LE(i * 2);
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / sampleCount);
    this.onAudioLevel(rms);
  }

  private tryReceiveResult(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        this.ws?.removeListener("message", handler);
        resolve();
      }, 50); // Short timeout for non-blocking

      const handler = (data: Buffer) => {
        clearTimeout(timer);
        this.ws?.removeListener("message", handler);
        const result = parseResponse(Buffer.from(data));
        if (result.text) {
          this.lastResult = result.text;
          if (this.onPartialResult && !result.isFinal) {
            this.onPartialResult(result.text);
          }
        }
        resolve();
      };

      this.ws.once("message", handler);
    });
  }

  /**
   * Finish the streaming session and return the final transcription.
   */
  async finish(): Promise<string> {
    if (this.finished) return this.lastResult;
    this.finished = true;

    if (!this.ws) return this.lastResult;

    try {
      // Flush remaining buffer
      await this.flushBuffer();

      // Send end marker (empty frame with NEG_WITH_SEQUENCE)
      this.seq++;
      const endFrame = buildAudioFrame(this.seq, Buffer.alloc(0), true);
      this.ws.send(endFrame);

      // Wait for final result
      const finalResult = await this.waitForFinalResult();
      if (finalResult.text) {
        this.lastResult = finalResult.text;
      }
    } catch (err) {
      console.error("[ASR] finish error:", err);
    }

    // Close WebSocket
    try {
      this.ws.close();
    } catch {}

    console.log(`[ASR] streaming session done: "${this.lastResult.slice(0, 60)}"`);
    return this.lastResult;
  }

  private waitForFinalResult(): Promise<AsrPartialResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.ws?.removeListener("message", handler);
        resolve({ text: this.lastResult, isFinal: true });
      }, 10000);

      const handler = (data: Buffer) => {
        const result = parseResponse(Buffer.from(data));
        if (result.isFinal || result.text) {
          clearTimeout(timer);
          this.ws?.removeListener("message", handler);
          resolve(result);
        }
      };

      this.ws!.on("message", handler);
    });
  }
}

// ── Legacy batch mode (for backward compatibility) ────────────────────────
export type { AsrResult as AsrBatchResult };

export async function transcribe(req: AsrRequest): Promise<AsrResult> {
  if (req.opusFrames.length === 0) return { text: "" };

  if (process.env.XIAOZHI_MOCK_ASR === "true") {
    console.log(
      `[asr] MOCK — returning canned text (${req.opusFrames.length} frames)`,
    );
    return { text: "模拟识别:测试音频" };
  }

  const session = new StreamingASRSession();
  await session.start();

  // Feed all frames
  for (const frame of req.opusFrames) {
    await session.addFrame(frame);
  }

  const text = await session.finish();
  return { text };
}
