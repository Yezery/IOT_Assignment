/**
 * TTS provider — Doubao WebSocket binary protocol (seed-tts-2.0).
 *
 * Protocol sequence:
 *   1. StartConnection → ConnectionStarted
 *   2. StartSession → SessionStarted
 *   3. TaskRequest (send text)
 *   4. FinishSession → collect TTSResponse audio → SessionFinished
 *   5. FinishConnection
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { env } from "@/lib/env";

// ── Protocol constants (matching huoshan_double_stream.py) ──────────────────
const PROTOCOL_VERSION = 0x01;
const DEFAULT_HEADER_SIZE = 0x01;
const FULL_CLIENT_REQUEST = 0x01;
const AUDIO_ONLY_RESPONSE = 0x0b;
const FULL_SERVER_RESPONSE = 0x09;
const MsgTypeFlagWithEvent = 0x04;
const JSON_SERIAL = 0x01;

const EVENT_StartConnection = 1;
const EVENT_FinishConnection = 2;
const EVENT_ConnectionStarted = 50;
const EVENT_StartSession = 100;
const EVENT_FinishSession = 102;
const EVENT_SessionStarted = 150;
const EVENT_SessionFinished = 152;
const EVENT_TaskRequest = 200;
const EVENT_TTSSentenceStart = 350;
const EVENT_TTSSentenceEnd = 351;
const EVENT_TTSResponse = 352;

// ── Types ──────────────────────────────────────────────────────────────────
export type TtsRequest = {
  text: string;
  voice?: string;
  speedRatio?: number;
  volumeRatio?: number;
  pitchRatio?: number;
};

export type TtsResult = {
  oggOpus: Buffer;
  durationMs: number;
};

// ── Binary helpers ─────────────────────────────────────────────────────────
function buildHeader(
  messageType: number,
  msgFlags = MsgTypeFlagWithEvent,
  serial = JSON_SERIAL,
) {
  const buf = Buffer.alloc(4);
  buf[0] = (PROTOCOL_VERSION << 4) | DEFAULT_HEADER_SIZE;
  buf[1] = (messageType << 4) | msgFlags;
  buf[2] = (serial << 4) | 0; // no compression
  buf[3] = 0;
  return buf;
}

function buildOptional(event: number, sessionId: string | null) {
  const parts: Buffer[] = [];
  const eventBuf = Buffer.alloc(4);
  eventBuf.writeInt32BE(event);
  parts.push(eventBuf);

  if (sessionId) {
    const idBytes = Buffer.from(sessionId, "utf-8");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeInt32BE(idBytes.length);
    parts.push(lenBuf);
    parts.push(idBytes);
  }

  return Buffer.concat(parts);
}

function buildPayload(obj: Record<string, unknown>) {
  const json = Buffer.from(JSON.stringify(obj), "utf-8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeInt32BE(json.length);
  return Buffer.concat([lenBuf, json]);
}

function buildMessage(
  event: number,
  sessionId: string | null,
  payloadObj: Record<string, unknown>,
) {
  const header = buildHeader(FULL_CLIENT_REQUEST);
  const optional = buildOptional(event, sessionId);
  const payload = buildPayload(payloadObj);
  return Buffer.concat([header, optional, payload]);
}

function readString(buf: Buffer, offset: number): [string, number] {
  if (offset + 4 > buf.length) return ["", offset];
  const size = buf.readInt32BE(offset);
  offset += 4;
  const str = buf.subarray(offset, offset + size).toString("utf-8");
  offset += size;
  return [str, offset];
}

function parseResponse(data: Buffer | ArrayBuffer) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 4) return { error: "too short" as const };

  const messageType = buf[1] >> 4;
  const msgFlags = buf[1] & 0x0f;
  const result: Record<string, unknown> = { messageType, msgFlags };
  let offset = 4;

  if (messageType === FULL_SERVER_RESPONSE || messageType === AUDIO_ONLY_RESPONSE) {
    if (msgFlags === MsgTypeFlagWithEvent) {
      result.event = buf.readInt32BE(offset);
      offset += 4;

      if (result.event === EVENT_ConnectionStarted) {
        const [connId, off2] = readString(buf, offset);
        result.connectionId = connId;
        offset = off2;
      } else if (result.event === EVENT_SessionStarted || result.event === EVENT_SessionFinished) {
        const [sessionId, off2] = readString(buf, offset);
        result.sessionId = sessionId;
        offset = off2;
        const [meta, off3] = readString(buf, offset);
        result.meta = meta;
        offset = off3;
      } else {
        // Read session_id + payload
        const [sessionId, off2] = readString(buf, offset);
        result.sessionId = sessionId;
        offset = off2;
        if (offset + 4 <= buf.length) {
          const payloadSize = buf.readInt32BE(offset);
          offset += 4;
          result.payload = buf.subarray(offset, offset + payloadSize);
          offset += payloadSize;
        }
      }
    }
  } else if (messageType === 0x0f) {
    // ERROR
    result.errorCode = buf.readInt32BE(offset);
    offset += 4;
    if (offset + 4 <= buf.length) {
      const payloadSize = buf.readInt32BE(offset);
      offset += 4;
      result.errorPayload = buf
        .subarray(offset, offset + payloadSize)
        .toString("utf-8");
    }
  }

  return result;
}

function waitForResponse(ws: WebSocket, timeoutMs = 15000) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("TTS WS response timeout")),
      timeoutMs,
    );
    const handler = (data: Buffer | ArrayBuffer) => {
      clearTimeout(timer);
      ws.off("error", errorHandler);
      const resp = parseResponse(data);
      if (resp.error) reject(new Error(`TTS parse: ${resp.error}`));
      else resolve(resp);
    };
    const errorHandler = (err: Error) => {
      clearTimeout(timer);
      ws.off("message", handler);
      reject(err);
    };
    ws.once("message", handler);
    ws.once("error", errorHandler);
  });
}

function wsConnect(url: string, headers: Record<string, string>) {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error(`TTS WS connect timeout: ${url}`)), 15000);
  });
}

// ── ffmpeg helpers ─────────────────────────────────────────────────────────
function ffmpeg(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(env.xiaozhi.ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const errs: string[] = [];
    proc.stdout.on("data", (b: Buffer) => out.push(b));
    proc.stderr.on("data", (s) => errs.push(s.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0)
        reject(new Error(`ffmpeg exit ${code}: ${errs.join("").slice(0, 400)}`));
      else resolve(Buffer.concat(out));
    });
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

function probeDuration(oggOpus: Buffer): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(
      env.xiaozhi.ffmpegPath,
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "null", "-"],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    const err: string[] = [];
    proc.stderr.on("data", (s: Buffer) => err.push(s.toString()));
    proc.on("close", () => {
      const m = /time=\s*([\d:.]+)/.exec(err.join(""));
      if (!m) return resolve(0);
      const [h, mm, s] = m[1].split(":").map(Number);
      resolve(((h ?? 0) * 3600 + (mm ?? 0) * 60 + (s ?? 0)) * 1000);
    });
    proc.stdin.write(oggOpus);
    proc.stdin.end();
  });
}

// ── Main TTS function ─────────────────────────────────────────────────────
export async function synthesize(req: TtsRequest): Promise<TtsResult> {
  if (process.env.XIAOZHI_MOCK_TTS === "true") {
    console.log(`[tts] MOCK — synthesizing ${req.text.length} chars to silent Ogg/Opus`);
    const oggOpus = await new Promise<Buffer>((resolve, reject) => {
      const proc = spawn(env.xiaozhi.ffmpegPath, [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=1:duration=2",
        "-ac", "1", "-ar", "16000",
        "-c:a", "libopus", "-b:a", "32k",
        "-application", "voip", "-vbr", "on",
        "-frame_duration", "60",
        "-f", "ogg", "pipe:1",
      ], { stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const errs: string[] = [];
      proc.stdout.on("data", (b: Buffer) => out.push(b));
      proc.stderr.on("data", (s) => errs.push(s.toString()));
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code !== 0) reject(new Error(`ffmpeg exit ${code}: ${errs.join("").slice(0, 200)}`));
        else resolve(Buffer.concat(out));
      });
    });
    return { oggOpus, durationMs: 2000 };
  }

  const apiKey = env.xiaozhi.doubao.apiKey;
  if (!apiKey) throw new Error("[tts] DOUBAO_API_KEY must be set");

  const voice = req.voice ?? env.xiaozhi.doubao.ttsVoice;
  const wsUrl = "wss://openspeech.bytedance.com/api/v3/tts/bidirection";
  // Auto-detect resource ID based on speaker pattern
  const is2dot0 = voice.includes("_uranus_") || voice.startsWith("saturn_");
  const isCloned = voice.startsWith("S_");
  const resourceId = isCloned ? "seed-icl-2.0" : is2dot0 ? "seed-tts-2.0" : "seed-tts-1.0";

  console.log(`[tts] voice=${voice} resource=${resourceId} chars=${req.text.length}`);

  // Connect with X-Api-Key auth
  const ws = await wsConnect(wsUrl, {
    "X-Api-Key": apiKey,
    "X-Api-Resource-Id": resourceId,
    "X-Api-Connect-Id": randomUUID(),
  }).catch((err: Error) => {
    if (err.message.includes("403")) {
      throw new Error(
        `[tts] 403 Forbidden: account is not subscribed to resource "${resourceId}" ` +
          `(voice "${voice}"). Use a voice whose family matches an enabled resource, ` +
          `e.g. *_uranus_bigtts with seed-tts-2.0.`,
      );
    }
    throw err;
  });

  try {
    // Step 1: StartConnection
    ws.send(buildMessage(EVENT_StartConnection, null, {}));
    const connResp = await waitForResponse(ws);
    if (connResp.event !== EVENT_ConnectionStarted) {
      throw new Error(`[tts] expected ConnectionStarted, got event=${connResp.event}`);
    }

    // Step 2: StartSession
    const sessionId = randomUUID().replace(/-/g, "");
    const sessionPayload = {
      user: { uid: "andy-studio-server" },
      event: EVENT_StartSession,
      namespace: "BidirectionalTTS",
      req_params: {
        text: "",
        speaker: voice,
        audio_params: {
          format: "pcm",
          sample_rate: 24000,
          speech_rate: req.speedRatio ?? 0,
          loudness_rate: req.volumeRatio ?? 0,
        },
        additions: JSON.stringify({}),
      },
    };
    ws.send(buildMessage(EVENT_StartSession, sessionId, sessionPayload));
    const sessionResp = await waitForResponse(ws);
    if (sessionResp.event !== EVENT_SessionStarted) {
      throw new Error(`[tts] expected SessionStarted, got event=${sessionResp.event}`);
    }

    // Step 3: Send text via TaskRequest
    const textPayload = {
      user: { uid: "andy-studio-server" },
      event: EVENT_TaskRequest,
      namespace: "BidirectionalTTS",
      req_params: {
        text: req.text,
        speaker: voice,
        audio_params: {
          format: "pcm",
          sample_rate: 24000,
          speech_rate: req.speedRatio ?? 0,
          loudness_rate: req.volumeRatio ?? 0,
        },
        additions: JSON.stringify({}),
      },
    };
    ws.send(buildMessage(EVENT_TaskRequest, sessionId, textPayload));

    // Step 4: FinishSession
    ws.send(buildMessage(EVENT_FinishSession, sessionId, {}));

    // Step 5: Collect audio
    const pcmChunks: Buffer[] = [];
    let finished = false;
    const deadline = Date.now() + 30000;

    while (!finished && Date.now() < deadline) {
      try {
        const resp = await waitForResponse(ws, 10000);

        if (resp.errorCode) {
          throw new Error(
            `[tts] server error code=${resp.errorCode} msg=${resp.errorPayload}`,
          );
        }
        if (
          resp.event === EVENT_TTSResponse &&
          (resp.messageType === AUDIO_ONLY_RESPONSE ||
            resp.messageType === FULL_SERVER_RESPONSE) &&
          resp.payload
        ) {
          pcmChunks.push(resp.payload as Buffer);
        }
        if (resp.event === EVENT_SessionFinished) {
          finished = true;
        }
      } catch (e) {
        if ((e as Error).message?.includes("timeout")) break;
        throw e;
      }
    }

    // Send FinishConnection
    try {
      ws.send(buildMessage(EVENT_FinishConnection, null, {}));
    } catch {}

    if (pcmChunks.length === 0) {
      throw new Error("[tts] no audio chunks received");
    }

    const pcm = Buffer.concat(pcmChunks);
    console.log(`[tts] PCM: ${pcm.length} bytes from ${pcmChunks.length} chunks`);

    // Convert PCM 24kHz → Ogg/Opus 16kHz
    const oggOpus = await ffmpeg(
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0",
        "-ac", "1", "-ar", "16000",
        "-c:a", "libopus", "-b:a", "32k",
        "-application", "voip", "-vbr", "on",
        "-frame_duration", "60",
        "-f", "ogg", "pipe:1",
      ],
      pcm,
    );

    const durationMs = await probeDuration(oggOpus);
    return { oggOpus, durationMs };
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

/* ==========================================================================
 * DoubaoStreamingTTS — long-lived bidirectional WebSocket for sentence streaming
 *
 * Lifecycle:
 *   1. start()       — open WS, send StartConnection + StartSession
 *   2. sendSentence(text) — push a TaskRequest; yields PCM chunks for that
 *                           single sentence, then resolves when SessionFinished
 *                           arrives for this sentence (or TTSResponse ends).
 *   3. end()         — FinishSession + FinishConnection + close WS
 *
 * Multiple sentences share the same WS connection; PCM sample rate is
 * configured to 24 kHz mono (matches the Batch API).
 *
 * The first PCM chunk returned by sendSentence() is preceded by an
 * optional SentenceStart metadata block — currently we drop it and only
 * surface the AUDIO_ONLY_RESPONSE payloads.
 * ========================================================================== */

export type StreamingTtsOptions = {
  voice?: string;
  speedRatio?: number;
  volumeRatio?: number;
  pitchRatio?: number;
};

type PendingSentence = {
  text: string;
  chunks: Buffer[];
  resolve: () => void;
  reject: (err: Error) => void;
  finished: boolean;
  wakeup: (() => void) | null;
};

export class DoubaoStreamingTTS {
  private ws: WebSocket | null = null;
  private readonly apiKey: string;
  private readonly voice: string;
  private readonly speedRatio: number;
  private readonly volumeRatio: number;
  private readonly pitchRatio: number;
  private readonly resourceId: string;
  private sessionId: string | null = null;
  private connectId: string;
  private readonly pending: PendingSentence[] = [];
  private messageHandler: ((data: Buffer | ArrayBuffer) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private started = false;

  public constructor(opts: StreamingTtsOptions = {}) {
    const apiKey = env.xiaozhi.doubao.apiKey;
    if (!apiKey) throw new Error("[tts-stream] DOUBAO_API_KEY must be set");
    this.apiKey = apiKey;
    this.voice = opts.voice ?? env.xiaozhi.doubao.ttsVoice;
    this.speedRatio = opts.speedRatio ?? 0;
    this.volumeRatio = opts.volumeRatio ?? 0;
    this.pitchRatio = opts.pitchRatio ?? 0;
    this.connectId = randomUUID();

    const is2dot0 =
      this.voice.includes("_uranus_") || this.voice.startsWith("saturn_");
    const isCloned = this.voice.startsWith("S_");
    this.resourceId = isCloned
      ? "seed-icl-2.0"
      : is2dot0
        ? "seed-tts-2.0"
        : "seed-tts-1.0";

    console.log(
      `[tts-stream] voice=${this.voice} resource=${this.resourceId}`,
    );
  }

  public async start(): Promise<void> {
    if (this.started) return;
    const wsUrl = "wss://openspeech.bytedance.com/api/v3/tts/bidirection";
    this.ws = await wsConnect(wsUrl, {
      "X-Api-Key": this.apiKey,
      "X-Api-Resource-Id": this.resourceId,
      "X-Api-Connect-Id": this.connectId,
    });

    this.messageHandler = (data) => this.handleMessage(data);
    this.errorHandler = (err) => {
      console.error(`[tts-stream] WS error:`, err.message);
      this.failAllPending(err);
    };
    this.closeHandler = () => {
      console.warn(`[tts-stream] WS closed unexpectedly`);
      this.failAllPending(
        new Error("[tts-stream] WS closed unexpectedly"),
      );
    };
    this.ws.on("message", this.messageHandler);
    this.ws.on("error", this.errorHandler);
    this.ws.on("close", this.closeHandler);

    this.ws.send(buildMessage(EVENT_StartConnection, null, {}));
    const connResp = await waitForResponse(this.ws);
    if (connResp.event !== EVENT_ConnectionStarted) {
      this.ws.close();
      throw new Error(
        `[tts-stream] expected ConnectionStarted, got event=${connResp.event}`,
      );
    }

    this.sessionId = randomUUID().replace(/-/g, "");
    const sessionPayload = {
      user: { uid: "andy-studio-server" },
      event: EVENT_StartSession,
      namespace: "BidirectionalTTS",
      req_params: {
        text: "",
        speaker: this.voice,
        audio_params: {
          format: "pcm",
          sample_rate: 24000,
          speech_rate: this.speedRatio,
          loudness_rate: this.volumeRatio,
        },
        additions: JSON.stringify({}),
      },
    };
    this.ws.send(buildMessage(EVENT_StartSession, this.sessionId, sessionPayload));
    const sessionResp = await waitForResponse(this.ws);
    if (sessionResp.event !== EVENT_SessionStarted) {
      this.ws.close();
      throw new Error(
        `[tts-stream] expected SessionStarted, got event=${sessionResp.event}`,
      );
    }

    this.started = true;
    console.log(`[tts-stream] session ready (voice=${this.voice})`);
  }

  /**
   * Stream audio for one sentence. Yields PCM chunks as they arrive;
   * the generator ends once the server signals the sentence is complete
   * (SessionFinished) or after an idle timeout.
   */
  public async *sendSentence(text: string): AsyncGenerator<Buffer, void, void> {
    if (!this.started || !this.ws || !this.sessionId) {
      throw new Error("[tts-stream] not started; call start() first");
    }

    const queue: Buffer[] = [];
    let resolveNext: (() => void) | null = null;
    let finished = false;
    const state: { reason: "ok" | "error"; err: Error | null } = {
      reason: "ok",
      err: null,
    };

    const pending: PendingSentence = {
      text,
      chunks: queue,
      resolve: () => {
        finished = true;
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      },
      reject: (err) => {
        finished = true;
        state.reason = "error";
        state.err = err;
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      },
      finished: false,
      wakeup: () => {
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      },
    };
    this.pending.push(pending);

    const taskPayload = {
      user: { uid: "andy-studio-server" },
      event: EVENT_TaskRequest,
      namespace: "BidirectionalTTS",
      req_params: {
        text,
        speaker: this.voice,
        audio_params: {
          format: "pcm",
          sample_rate: 24000,
          speech_rate: this.speedRatio,
          loudness_rate: this.volumeRatio,
        },
        additions: JSON.stringify({}),
      },
    };
    try {
      this.ws.send(
        buildMessage(EVENT_TaskRequest, this.sessionId, taskPayload),
      );
      console.log(
        `[tts-stream] TaskRequest sent for "${text.slice(0, 40)}..."`,
      );
    } catch (err) {
      const idx = this.pending.indexOf(pending);
      if (idx >= 0) this.pending.splice(idx, 1);
      throw err;
    }

    // First-byte timeout: if Doubao never sends ANY response (SentenceStart
    // or audio) within this window, the session is likely dead — bail out
    // so the caller can rebuild the pipeline.
    const FIRST_BYTE_TIMEOUT_MS = Number(
      process.env.XIAOZHI_TTS_FIRST_BYTE_TIMEOUT_MS || 15_000,
    );
    // Inter-chunk timeout: once we start receiving audio, gaps longer than
    // this mean the server has stopped mid-sentence.
    const CHUNK_TIMEOUT_MS = Number(
      process.env.XIAOZHI_TTS_CHUNK_TIMEOUT_MS || 30_000,
    );
    let firstByteSeen = false;
    let lastByteAt = Date.now();

    try {
      let watchdog: NodeJS.Timeout | null = null;
      while (true) {
        if (state.reason === "error") throw state.err;
        if (queue.length > 0) {
          const chunk = queue.shift() as Buffer;
          firstByteSeen = true;
          lastByteAt = Date.now();
          if (watchdog) { clearTimeout(watchdog); watchdog = null; }
          yield chunk;
          continue;
        }
        if (finished) {
          if (watchdog) { clearTimeout(watchdog); watchdog = null; }
          // If the session ended without ever producing audio for this
          // sentence, the long-lived WS path is likely broken (voice
          // mismatch, quota, session invalidated). Throw so the caller
          // can rebuild the pipeline — typically the next reply will
          // succeed because batch fallback will have invalidated the
          // cached entry via invalidateTtsPipeline().
          if (!firstByteSeen) {
            throw new Error(
              `[tts-stream] SentenceEnd arrived with 0 audio chunks — long-lived TTS session appears broken`,
            );
          }
          return;
        }
        const elapsedSinceLastByte = Date.now() - lastByteAt;
        const limit = firstByteSeen ? CHUNK_TIMEOUT_MS : FIRST_BYTE_TIMEOUT_MS;
        if (elapsedSinceLastByte > limit) {
          throw new Error(
            `[tts-stream] no response for ${limit}ms (firstByte=${firstByteSeen}) — session likely dead`,
          );
        }
        // Re-arm the watchdog on every loop iteration so the timeout
        // is relative to the last server activity, not the start of
        // the sentence. We bound the sleep so a real event still wakes
        // us promptly via resolveNext.
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
          if (watchdog) clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            if (resolveNext) {
              const r = resolveNext;
              resolveNext = null;
              r();
            }
          }, Math.min(limit, 5000));
        });
        resolveNext = null;
      }
    } finally {
      const idx = this.pending.indexOf(pending);
      if (idx >= 0) this.pending.splice(idx, 1);
    }
  }

  public async end(): Promise<void> {
    if (!this.started || !this.ws || !this.sessionId) {
      this.ws?.close();
      this.ws = null;
      return;
    }
    const sessionId = this.sessionId;
    try {
      this.ws.send(buildMessage(EVENT_FinishSession, sessionId, {}));
      // Drain any remaining SessionFinished event before closing.
      await waitForResponse(this.ws, 3000).catch(() => {});
      this.ws.send(buildMessage(EVENT_FinishConnection, null, {}));
    } catch {}
    try {
      this.ws.close();
    } catch {}
    this.ws = null;
    this.started = false;
    this.sessionId = null;
  }

  /** Whether the underlying WebSocket is still open (readyState === OPEN).
   *  Used by callers to detect stale long-lived connections. */
  public isAlive(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  private handleMessage(data: Buffer | ArrayBuffer): void {
    const buf0 = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const byte0 = buf0[0];
    const byte1 = buf0[1];
    const resp = parseResponse(data);
    const payloadBuf = resp.payload as Buffer | undefined;
    let payloadAsText = "";
    if (payloadBuf && payloadBuf.length > 0 && payloadBuf.length < 256) {
      payloadAsText = ` text=${JSON.stringify(payloadBuf.toString("utf-8"))}`;
    } else if (payloadBuf) {
      payloadAsText = ` text=<${payloadBuf.length} bytes>`;
    }
    console.log(
      `[tts-stream] raw byte0=0x${byte0?.toString(16)} byte1=0x${byte1?.toString(16)} parsed event=${resp.event} msgType=${resp.messageType} hasPayload=${!!resp.payload} payloadSize=${payloadBuf?.length ?? 0}${payloadAsText}`,
    );
    if (resp.errorCode) {
      console.error(
        `[tts-stream] server error code=${resp.errorCode} msg=${resp.errorPayload}`,
      );
      this.failAllPending(
        new Error(
          `[tts-stream] server error code=${resp.errorCode} msg=${resp.errorPayload}`,
        ),
      );
      return;
    }
    const pending = this.pending[this.pending.length - 1];
    if (!pending) {
      // First few messages (ConnectionStarted, SessionStarted) arrive
      // before any pending sentence exists — that's expected.
      if (
        resp.event !== EVENT_ConnectionStarted &&
        resp.event !== EVENT_SessionStarted
      ) {
        console.warn(
          `[tts-stream] received event=${resp.event} msgType=${resp.messageType} but no pending sentence`,
        );
      }
      return;
    }

    if (
      resp.event === EVENT_TTSResponse &&
      (resp.messageType === AUDIO_ONLY_RESPONSE ||
        resp.messageType === FULL_SERVER_RESPONSE) &&
      resp.payload
    ) {
      const buf = resp.payload as Buffer;
      pending.chunks.push(buf);
      pending.wakeup?.();
    } else if (resp.event === EVENT_TTSSentenceStart) {
      console.log(
        `[tts-stream] SentenceStart text=${pending.text.slice(0, 40)}... payloadText=${payloadAsText}`,
      );
      pending.wakeup?.();
    } else if (resp.event === EVENT_TTSSentenceEnd) {
      console.log(
        `[tts-stream] SentenceEnd chunks=${pending.chunks.length} totalBytes=${pending.chunks.reduce((s, c) => s + c.length, 0)}${payloadAsText}`,
      );
      pending.resolve();
    } else if (resp.event === EVENT_SessionFinished) {
      console.log(
        `[tts-stream] SessionFinished chunks=${pending.chunks.length} totalBytes=${pending.chunks.reduce((s, c) => s + c.length, 0)}${payloadAsText}`,
      );
      pending.resolve();
    }
  }

  private failAllPending(err: Error): void {
    while (this.pending.length > 0) {
      const p = this.pending.shift() as PendingSentence;
      p.reject(err);
    }
  }
}

/**
 * Extract Opus packets from an Ogg/Opus byte stream.
 *
 * Walks Ogg pages, skipping the first page (OpusHead) and any tag page
 * (OpusTags), and yields one Buffer per raw Opus packet.
 *
 * Reusable across the streaming and batch pipelines.
 */
export function extractOpusPacketsFromOgg(data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let offset = 0;
  let isFirstPage = true;

  while (offset + 27 <= data.length) {
    if (
      data[offset] !== 0x4f ||
      data[offset + 1] !== 0x67 ||
      data[offset + 2] !== 0x67 ||
      data[offset + 3] !== 0x53
    ) {
      break;
    }

    const numSegments = data[offset + 26];
    const headerSize = 27 + numSegments;
    if (offset + headerSize > data.length) break;

    let pageDataSize = 0;
    const segmentTable: number[] = [];
    for (let i = 0; i < numSegments; i++) {
      const size = data[offset + 27 + i];
      segmentTable.push(size);
      pageDataSize += size;
    }

    const dataStart = offset + headerSize;
    if (dataStart + pageDataSize > data.length) break;

    if (isFirstPage) {
      isFirstPage = false;
      offset = dataStart + pageDataSize;
      continue;
    }

    let dataOffset = dataStart;
    let packetParts: Buffer[] = [];
    for (const segSize of segmentTable) {
      packetParts.push(data.subarray(dataOffset, dataOffset + segSize));
      dataOffset += segSize;
      if (segSize < 255) {
        const packet = Buffer.concat(packetParts);
        if (packet.subarray(0, 8).toString("latin1") !== "OpusTags") {
          packets.push(packet);
        }
        packetParts = [];
      }
    }

    offset = dataStart + pageDataSize;
  }

  return packets;
}

export const OPUS_FRAME_MS = 60;

/**
 * Long-lived PCM→Opus encoder backed by a single ffmpeg subprocess.
 *
 * The first call to `feed()` lazily starts ffmpeg; subsequent feeds share
 * the same encoder so we avoid the 200-400 ms cold-start cost per sentence.
 * `close()` flushes any buffered audio and terminates the encoder.
 */
export class OpusEncoder {
  private proc: ReturnType<typeof spawn> | null = null;
  private readonly queue: Buffer[] = [];
  private waiter: (() => void) | null = null;
  private oggCarry = Buffer.alloc(0);
  private lastFlush = 0;
  private stderrBuf = "";
  private closed = false;

  public feed(chunk: Buffer): void {
    if (this.closed) return;
    this.ensureStarted();
    const proc = this.proc;
    const stdin = proc?.stdin;
    if (stdin?.writable) {
      stdin.write(chunk);
    }
  }

  /** Stream Opus frames produced by the encoder. */
  public async *frames(): AsyncGenerator<Buffer, void, void> {
    this.ensureStarted();
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift() as Buffer;
        continue;
      }
      const proc = this.proc;
      if (this.closed && this.queue.length === 0) return;
      if (proc && proc.exitCode !== null && this.queue.length === 0) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = null;
    }
  }

  /** Wake every consumer blocked in `frames()` without changing state. */
  public wakeConsumers(): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    const stdin = this.proc?.stdin;
    if (!stdin) return;
    try {
      stdin.end();
    } catch {}
  }

  private ensureStarted(): void {
    if (this.proc) return;
    this.lastFlush = Date.now();
    const proc = spawn(
      env.xiaozhi.ffmpegPath,
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0",
        "-ac", "1", "-ar", "16000",
        "-c:a", "libopus", "-b:a", "32k",
        "-application", "voip", "-vbr", "on",
        "-frame_duration", "60",
        "-f", "ogg", "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.proc = proc;

    proc.stdout?.on("data", (b: Buffer) => {
      this.oggCarry = Buffer.concat([this.oggCarry, b]);
      // Flush every ~60 ms (one Opus frame) so callers see audio fast.
      const now = Date.now();
      if (now - this.lastFlush >= OPUS_FRAME_MS || this.oggCarry.length > 4096) {
        const frames = extractOpusPacketsFromOgg(this.oggCarry);
        this.oggCarry = Buffer.alloc(0);
        for (const f of frames) this.queue.push(f);
        this.lastFlush = now;
      }
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w();
      }
    });
    proc.stderr?.on("data", (s: Buffer) => {
      this.stderrBuf += s.toString();
    });
    proc.on("error", () => {});
    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(
          `[tts-stream] ffmpeg exit ${code}: ${this.stderrBuf.slice(0, 400)}`,
        );
      }
      // Final flush of remaining bytes before signalling EOF.
      const frames = extractOpusPacketsFromOgg(this.oggCarry);
      this.oggCarry = Buffer.alloc(0);
      for (const f of frames) this.queue.push(f);
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w();
      }
    });
  }
}

/**
 * Backwards-compatible single-shot encoder used by the batch pipeline.
 * New callers should prefer `OpusEncoder` for streaming use cases.
 */
export async function* encodePcmToOpusStream(
  pcmChunks: AsyncIterable<Buffer>,
): AsyncGenerator<Buffer, void, void> {
  const enc = new OpusEncoder();
  (async () => {
    try {
      for await (const chunk of pcmChunks) {
        enc.feed(chunk);
      }
    } catch {}
    enc.close();
  })();
  for await (const frame of enc.frames()) {
    yield frame;
  }
}
