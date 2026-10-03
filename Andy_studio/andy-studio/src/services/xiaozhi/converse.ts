import { chatService, buildAgentOpts } from "@/services/chat-service";
import { sendCommand } from "./commands";
import { db } from "@/storage/db";
import { writeAudit } from "./audit";
import { appendMessage } from "@/services/chat-history";
import { StreamingASRSession, transcribe as asrTranscribe } from "./asr";
import {
  synthesize as ttsSynthesize,
  DoubaoStreamingTTS,
  OpusEncoder,
  extractOpusPacketsFromOgg,
  OPUS_FRAME_MS,
} from "./tts";
import { pushFrame, drainFrames, clearFrames, audioBuffers } from "./audio-buffer";
import { sendAudioToClient, resetUdpClient } from "@/lib/xiaozhi/udp-server";
import type { Listen } from "./protocol";

async function sendOpusViaUdp(clientId: string, oggOpus: Buffer): Promise<boolean> {
  try {
    const frames = extractOpusPacketsFromOgg(oggOpus);
    if (frames.length === 0) {
      console.warn(`[Converse] no Opus frames extracted for ${clientId}`);
      return false;
    }

    console.log(`[Converse] sending ${frames.length} Opus frames via UDP to ${clientId}`);

    const startAt = Date.now();
    for (let i = 0; i < frames.length; i++) {
      const wait = startAt + i * OPUS_FRAME_MS - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      await sendAudioToClient(clientId, frames[i]);
    }

    return true;
  } catch (err) {
    console.error(`[Converse] UDP send failed for ${clientId}:`, err);
    return false;
  }
}

declare global {
  var __xiaozhiSessions: Map<string, { clientId: string; mode: Listen["mode"]; active: boolean }> | undefined;
  var __streamingASR: Map<string, StreamingASRSession> | undefined;
  var __streamingFinalText: Map<string, string> | undefined;
  var __silenceTimers: Map<string, ReturnType<typeof setTimeout>> | undefined;
  var __lastSpeechTime: Map<string, number> | undefined;
  var __hasSpeech: Map<string, boolean> | undefined;
  var __listenStart: Map<string, number> | undefined;
  var __peakRms: Map<string, number> | undefined;
  var __lastRms: Map<string, number> | undefined;
  var __rmsWindow: Map<string, number[]> | undefined;
  var __noiseFloor: Map<string, number> | undefined;
  var __replyInFlight: Map<string, boolean> | undefined;
  var __pendingListen: Map<string, Listen["mode"]> | undefined;
  var __udpNoSession: number | undefined;
  /**
   * Long-lived per-device TTS pipeline: a single Doubao bidirectional TTS
   * WebSocket plus a shared PCM→Opus ffmpeg encoder. Held across replies
   * so the second reply onwards skips the 200-500 ms StartConnection +
   * StartSession handshake. Cleared in `closeSession` / `abort`.
   */
  var __xiaozhiTts: Map<string, { tts: DoubaoStreamingTTS; encoder: OpusEncoder }> | undefined;
}

const SILENCE_TIMEOUT_MS = Number(process.env.XIAOZHI_SILENCE_TIMEOUT_MS || 1500);
const NO_SPEECH_TIMEOUT_MS = Number(process.env.XIAOZHI_NO_SPEECH_TIMEOUT_MS || 3000);
const SPEECH_CHECK_INTERVAL_MS = 250;
const VOICE_RMS_THRESHOLD = Number(process.env.XIAOZHI_VAD_RMS_THRESHOLD || 500);
const RMS_WINDOW = 40;
const NOISE_FLOOR_MULTIPLIER = 1.8;
const VAD_GRACE_MS = Number(process.env.XIAOZHI_VAD_GRACE_MS || 1500);
const DEBUG_VAD = process.env.XIAOZHI_DEBUG_VAD === "true";

function isTtsEnabled(): boolean {
  const raw = process.env.XIAOZHI_TTS_ENABLED;
  if (raw === undefined || raw === "") return true;
  return ["true", "1", "yes", "on"].includes(raw.toLowerCase());
}

const DEVICE_EMOTION: Record<string, string> = {
  neutral: "neutral",
  happy: "happy",
  sad: "sad",
  angry: "angry",
  anxious: "shocked",
  curious: "thinking",
  tired: "sleepy",
  unknown: "neutral",
};

function toDeviceEmotion(label: string): string {
  return DEVICE_EMOTION[label] ?? "neutral";
}

// The reply pipeline hands the LLM's full text to TTS in one call.
// Sentence-level splitting has been removed on purpose: the firmware
// drives playback itself, so the server must not slice the reply.


function resolveMessageContent(m: unknown): string {
  const c = (m as { content?: unknown })?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b: unknown) => {
        if (typeof b === "string") return b;
        const obj = b as { type?: string; text?: string };
        if (obj?.type === "text") return obj.text ?? "";
        return "";
      })
      .join("");
  }
  return "";
}

function isAssistantFinalMessage(m: unknown): boolean {
  const mm = m as { role?: unknown; type?: unknown; tool_calls?: unknown };
  const role = typeof mm.role === "string" ? mm.role : (typeof mm.type === "string" ? mm.type : "");
  if (role !== "assistant" && role !== "ai") return false;
  // Skip messages that issued tool calls — those are intermediate.
  if (Array.isArray(mm.tool_calls) && mm.tool_calls.length > 0) return false;
  return true;
}

/**
 * Pick the assistant message that should be streamed to the device:
 * the last AI message without tool_calls. Earlier AI messages are
 * intermediate turns that asked the agent to call a tool; we don't
 * want to read those out loud.
 */
export function pickFinalAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isAssistantFinalMessage(m)) continue;
    return resolveMessageContent(m).trim();
  }
  return "";
}

function silenceTimers(): Map<string, ReturnType<typeof setTimeout>> {
  if (!globalThis.__silenceTimers) globalThis.__silenceTimers = new Map();
  return globalThis.__silenceTimers;
}

function lastSpeechTime(): Map<string, number> {
  if (!globalThis.__lastSpeechTime) globalThis.__lastSpeechTime = new Map();
  return globalThis.__lastSpeechTime;
}

function hasSpeech(): Map<string, boolean> {
  if (!globalThis.__hasSpeech) globalThis.__hasSpeech = new Map();
  return globalThis.__hasSpeech;
}

function listenStarts(): Map<string, number> {
  if (!globalThis.__listenStart) globalThis.__listenStart = new Map();
  return globalThis.__listenStart;
}

function peakRms(): Map<string, number> {
  if (!globalThis.__peakRms) globalThis.__peakRms = new Map();
  return globalThis.__peakRms;
}

function lastRms(): Map<string, number> {
  if (!globalThis.__lastRms) globalThis.__lastRms = new Map();
  return globalThis.__lastRms;
}

function rmsWindow(): Map<string, number[]> {
  if (!globalThis.__rmsWindow) globalThis.__rmsWindow = new Map();
  return globalThis.__rmsWindow;
}

function noiseFloor(): Map<string, number> {
  if (!globalThis.__noiseFloor) globalThis.__noiseFloor = new Map();
  return globalThis.__noiseFloor;
}

function replyInFlight(): Map<string, boolean> {
  if (!globalThis.__replyInFlight) globalThis.__replyInFlight = new Map();
  return globalThis.__replyInFlight;
}

function pendingListen(): Map<string, Listen["mode"]> {
  if (!globalThis.__pendingListen) globalThis.__pendingListen = new Map();
  return globalThis.__pendingListen;
}

function ttsPipelines(): Map<string, { tts: DoubaoStreamingTTS; encoder: OpusEncoder }> {
  if (!globalThis.__xiaozhiTts) globalThis.__xiaozhiTts = new Map();
  return globalThis.__xiaozhiTts;
}

// Reserved for deployments that enable a verified bidirectional TTS voice.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function acquireTtsPipeline(
  clientId: string,
): Promise<{ tts: DoubaoStreamingTTS; encoder: OpusEncoder } | null> {
  if (!isTtsEnabled()) return null;
  const existing = ttsPipelines().get(clientId);
  if (existing) {
    // Verify the cached WS is still alive before reusing it — the WS
    // may have been killed by an idle timeout or network blip while
    // the device wasn't talking. If it's dead, drop the cache so we
    // rebuild below.
    if (!existing.tts.isAlive()) {
      console.warn(
        `[Converse] TTS pipeline stale for ${clientId}, rebuilding`,
      );
      try {
        existing.encoder.close();
      } catch {}
      try {
        await existing.tts.end();
      } catch {}
      ttsPipelines().delete(clientId);
    } else {
      return existing;
    }
  }
  const tts = new DoubaoStreamingTTS();
  await tts.start();
  const encoder = new OpusEncoder();
  const entry = { tts, encoder };
  ttsPipelines().set(clientId, entry);
  return entry;
}

/**
 * Drop the cached pipeline after the underlying TTS WebSocket closes,
 * so the next reply rebuilds it. Called both proactively on `end()`
 * failure and reactively from the WS error handler.
 */
async function invalidateTtsPipeline(clientId: string): Promise<void> {
  const entry = ttsPipelines().get(clientId);
  if (!entry) return;
  ttsPipelines().delete(clientId);
  try {
    entry.encoder.close();
  } catch {}
  try {
    await entry.tts.end();
  } catch {}
}

function clearSilenceState(clientId: string): void {
  lastSpeechTime().delete(clientId);
  hasSpeech().delete(clientId);
  listenStarts().delete(clientId);
  peakRms().delete(clientId);
  lastRms().delete(clientId);
  rmsWindow().delete(clientId);
  noiseFloor().delete(clientId);
}

function startSilenceWatch(clientId: string): void {
  const timers = silenceTimers();
  if (timers.has(clientId)) return;

  const now = Date.now();
  listenStarts().set(clientId, now);
  lastSpeechTime().set(clientId, now);
  hasSpeech().set(clientId, false);
  console.log(`[Converse] silence watch started for ${clientId} (rms threshold=${VOICE_RMS_THRESHOLD})`);

  let tick = 0;
  const check = async () => {
    const session = sessions().get(clientId);
    if (!session?.active || session.mode === "manual") {
      console.log(`[Converse] silence watch stopped for ${clientId} (session inactive or manual)`);
      timers.delete(clientId);
      clearSilenceState(clientId);
      return;
    }

    if (replyInFlight().get(clientId)) {
      listenStarts().set(clientId, Date.now());
      lastSpeechTime().set(clientId, Date.now());
      hasSpeech().set(clientId, false);
      timers.set(clientId, setTimeout(check, SPEECH_CHECK_INTERVAL_MS));
      return;
    }

    tick++;
    if (DEBUG_VAD && tick % 8 === 0) {
      const peak = peakRms().get(clientId) ?? 0;
      const last = lastRms().get(clientId) ?? 0;
      const floor = noiseFloor().get(clientId) ?? 0;
      const spoke = hasSpeech().get(clientId) ?? false;
      const sinceVoice = Date.now() - (lastSpeechTime().get(clientId) ?? Date.now());
      console.log(
        `[Converse] ${clientId.slice(0, 8)} rms peak=${peak.toFixed(0)} last=${last.toFixed(0)} floor=${floor.toFixed(0)} spoke=${spoke} sinceVoice=${sinceVoice}ms`,
      );
      peakRms().set(clientId, 0);
    }

    const startedAt = listenStarts().get(clientId) ?? Date.now();
    const lastSpoken = lastSpeechTime().get(clientId) ?? startedAt;
    const spoke = hasSpeech().get(clientId) ?? false;
    const sinceVoice = Date.now() - lastSpoken;
    const sinceStart = Date.now() - startedAt;

    const silentAfterSpeech = spoke && sinceVoice >= SILENCE_TIMEOUT_MS;
    const noSpeechAtAll = !spoke && sinceStart >= NO_SPEECH_TIMEOUT_MS;

    if (noSpeechAtAll) {
      timers.delete(clientId);
      clearSilenceState(clientId);
      console.log(
        `[Converse] entering sleep for ${clientId} (no speech for ${sinceStart}ms) — closing UDP + goodbye`,
      );
      await stopListening(clientId);
      resetUdpClient(clientId);
      await sendCommand(clientId, { type: "goodbye" });
      await closeSession(clientId);
      return;
    }

    if (silentAfterSpeech) {
      timers.delete(clientId);
      const mode = session.mode;
      clearSilenceState(clientId);
      console.log(
        `[Converse] silence detected for ${clientId} (spoke=${spoke}, sinceVoice=${sinceVoice}ms)`,
      );
      await stopListening(clientId);
      await finalizeUtterance(clientId);
      if (mode === "auto") {
        await startListening(clientId, "auto");
      }
      return;
    }

    timers.set(clientId, setTimeout(check, SPEECH_CHECK_INTERVAL_MS));
  };

  timers.set(clientId, setTimeout(check, SPEECH_CHECK_INTERVAL_MS));
}

function onAudioLevel(clientId: string, rms: number): void {
  lastRms().set(clientId, rms);
  const prevPeak = peakRms().get(clientId) ?? 0;
  if (rms > prevPeak) peakRms().set(clientId, rms);

  const win = rmsWindow().get(clientId) ?? [];
  win.push(rms);
  if (win.length > RMS_WINDOW) win.shift();
  rmsWindow().set(clientId, win);

  const sorted = [...win].sort((a, b) => a - b);
  const floor = win.length >= 10 ? sorted[Math.floor(sorted.length * 0.25)] : 0;
  noiseFloor().set(clientId, floor);

  const startedAt = listenStarts().get(clientId) ?? 0;
  if (startedAt > 0 && Date.now() - startedAt < VAD_GRACE_MS) {
    return;
  }

  const threshold = Math.max(VOICE_RMS_THRESHOLD, floor * NOISE_FLOOR_MULTIPLIER);
  if (rms >= threshold) {
    const wasSpeaking = hasSpeech().get(clientId) ?? false;
    if (!wasSpeaking) {
      console.log(
        `[Converse] voice detected for ${clientId} (rms=${rms.toFixed(0)}, floor=${floor.toFixed(0)}, thr=${threshold.toFixed(0)})`,
      );
    }
    hasSpeech().set(clientId, true);
    lastSpeechTime().set(clientId, Date.now());
  }
}

function stopSilenceWatch(clientId: string): void {
  const timers = silenceTimers();
  const t = timers.get(clientId);
  if (t) clearTimeout(t);
  timers.delete(clientId);
  clearSilenceState(clientId);
}

function sessions(): Map<string, { clientId: string; mode: Listen["mode"]; active: boolean }> {
  if (!globalThis.__xiaozhiSessions) globalThis.__xiaozhiSessions = new Map();
  return globalThis.__xiaozhiSessions;
}

function streamingSessions(): Map<string, StreamingASRSession> {
  if (!globalThis.__streamingASR) globalThis.__streamingASR = new Map();
  return globalThis.__streamingASR;
}

function streamingFinalTexts(): Map<string, string> {
  if (!globalThis.__streamingFinalText) globalThis.__streamingFinalText = new Map();
  return globalThis.__streamingFinalText;
}

export async function startListening(clientId: string, mode: Listen["mode"]): Promise<void> {
  if (replyInFlight().get(clientId)) {
    // The firmware can request listen/start immediately after receiving a
    // thinking/start command. Do not start ASR over playback; defer it until
    // the server has sent tts:stop and finished its audio sequence.
    pendingListen().set(clientId, mode);
    console.log(`[Converse] startListening deferred for ${clientId} (reply in flight, mode=${mode})`);
    return;
  }
  const map = sessions();
  const existing = map.get(clientId);
  if (existing?.active) {
    console.log(`[Converse] startListening ignored for ${clientId} (already active, mode=${existing.mode})`);
    return;
  }
  map.set(clientId, { clientId, mode, active: true });
  console.log(`[Converse] startListening ${clientId} mode=${mode}`);

  clearFrames(clientId);
  stopSilenceWatch(clientId);
  if (mode !== "manual") {
    startSilenceWatch(clientId);
  }

  try {
    const session = new StreamingASRSession();
    session.setOnPartialResult((text) => {
      sendCommand(clientId, { type: "stt", payload: { text } }).catch(() => {});
    });
    session.setOnAudioLevel((rms) => {
      onAudioLevel(clientId, rms);
    });
    await session.start();
    streamingSessions().set(clientId, session);
    console.log(`[Converse] streaming ASR started for ${clientId}`);
  } catch (err) {
    console.error(`[Converse] failed to start streaming ASR:`, err);
  }
}

export async function stopListening(clientId: string): Promise<void> {
  stopSilenceWatch(clientId);

  // Any pending auto-listen request was tied to this utterance; drop it
  // so the silence/idle branch owns the next decision.
  pendingListen().delete(clientId);

  const map = sessions();
  map.delete(clientId);

  // Finish streaming ASR and get final text
  const session = streamingSessions().get(clientId);
  if (session) {
    try {
      const finalText = await session.finish();
      if (finalText) {
        streamingFinalTexts().set(clientId, finalText);
        console.log(`[Converse] streaming ASR final: "${finalText.slice(0, 60)}"`);
      }
    } catch (err) {
      console.error(`[Converse] streaming ASR finish error:`, err);
    }
    streamingSessions().delete(clientId);
  }
}

export function ingestAudioFrame(clientId: string, base64Data: string): void {
  const buf = Buffer.from(base64Data, "base64");
  pushFrame(clientId, buf);

  const session = streamingSessions().get(clientId);
  if (session) {
    session.addFrame(buf).catch((err) => {
      console.error(`[Converse] streaming addFrame error:`, err);
    });
  }
}

export function ingestUdpAudioFrame(clientId: string, frame: Buffer): void {
  pushFrame(clientId, frame);

  const session = streamingSessions().get(clientId);
  if (session) {
    session.addFrame(frame).catch((err) => {
      console.error(`[Converse] streaming addFrame error:`, err);
    });
  } else if (DEBUG_VAD) {
    const n = (globalThis.__udpNoSession ?? 0) + 1;
    globalThis.__udpNoSession = n;
    if (n % 50 === 1) {
      console.warn(`[Converse] UDP frame but no streaming ASR session for ${clientId} (count=${n})`);
    }
  }
}

export async function handleStt(clientId: string, text: string): Promise<void> {
  try {
    await runReplyPipelineGuarded(clientId, text);
  } catch (err) {
    console.error(`[Converse] handleStt failed for ${clientId}:`, err);
  }
}

export async function finalizeUtterance(clientId: string): Promise<void> {
  // Use streaming ASR final text if available
  const streamingText = streamingFinalTexts().get(clientId);
  streamingFinalTexts().delete(clientId);

  if (streamingText) {
    console.log(`[Converse] using streaming ASR result for ${clientId}`);
    clearFrames(clientId);
    await writeAudit({
      actor: "device",
      actorId: clientId,
      action: "converse.asr",
      target: `device:${clientId}`,
      payload: { text: streamingText, mode: "streaming" },
    });
    await runReplyPipelineGuarded(clientId, streamingText);
    return;
  }

  // Fall back to batch ASR
  const frames = drainFrames(clientId);
  console.log(`[Converse] finalizeUtterance ${clientId}: ${frames.length} frames (batch)`);
  if (frames.length === 0) {
    console.log(`[Converse] ⚠ No audio frames received for ${clientId}`);
    return;
  }

  try {
    const asr = await asrTranscribe({ opusFrames: frames });
    const text = asr.text.trim();
    if (!text) return;
    console.log(`[Converse] ASR batch ${clientId} → "${text.slice(0, 60)}"`);
    await writeAudit({
      actor: "device",
      actorId: clientId,
      action: "converse.asr",
      target: `device:${clientId}`,
      payload: { text, frames: frames.length, mode: "batch" },
    });
    await runReplyPipelineGuarded(clientId, text);
  } catch (err) {
    console.error(`[Converse] ASR failed for ${clientId}:`, err);
  }
}

async function speakReply(
  clientId: string,
  reply: string,
  emotionLabel: string,
): Promise<void> {
  await sendCommand(clientId, {
    type: "tts",
    payload: { state: "start" },
  });

  await sendCommand(clientId, {
    type: "llm",
    payload: { emotion: toDeviceEmotion(emotionLabel), text: reply },
  });

  await sendCommand(clientId, {
    type: "tts",
    payload: { state: "sentence_start", text: reply },
  });

  // The whole reply goes to TTS in one request. `sentence_start` is emitted
  // exactly once per reply so the firmware sees a single playback unit; the
  // server never slices the LLM output into sub-sentences.

  let ttsOk = false;
  let opusBytes = 0;
  let durationMs = 0;
  if (!isTtsEnabled()) {
    console.log(`[Converse] TTS disabled (XIAOZHI_TTS_ENABLED), skipping synthesis for ${clientId}`);
  } else {
    try {
      const tts = await ttsSynthesize({ text: reply });
      if (tts.oggOpus.length > 0) {
        opusBytes = tts.oggOpus.length;
        durationMs = tts.durationMs;
        ttsOk = true;

        console.log(`[Converse] TTS ${clientId} → ${opusBytes}B ogg/opus (${durationMs}ms)`);

        const sent = await sendOpusViaUdp(clientId, tts.oggOpus);
        if (!sent) {
          console.warn(`[Converse] UDP send failed, falling back to notify URL`);
          const { writeFile, mkdir } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const { randomBytes } = await import("node:crypto");
          const audioDir = join(process.cwd(), ".tmp-audio");
          await mkdir(audioDir, { recursive: true });
          const filename = `${clientId.slice(0, 8)}-${randomBytes(8).toString("hex")}.ogg`;
          await writeFile(join(audioDir, filename), tts.oggOpus);
          const base = process.env.XIAOZHI_OTA_BASE_URL || "http://localhost:3000";
          const audioUrl = `${base}/api/tts-audio/${filename}`;
          await sendCommand(clientId, {
            type: "notify",
            payload: { audio_url: audioUrl },
          });
        }
      }
    } catch (err) {
      console.error(`[Converse] TTS failed for ${clientId}:`, err);
    }
  }

  await sendCommand(clientId, {
    type: "tts",
    payload: { state: "stop" },
  });

  await sendCommand(clientId, {
    type: "mcp",
    payload: {
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { emotion: emotionLabel, text: reply, tts_ok: ttsOk, opus_bytes: opusBytes, duration_ms: durationMs },
    },
  });

  await writeAudit({
    actor: "device",
    actorId: clientId,
    action: "converse.reply",
    target: `device:${clientId}`,
    payload: { emotion: emotionLabel, length: reply.length, tts_ok: ttsOk, opus_bytes: opusBytes, duration_ms: durationMs },
  });
}

async function runReplyPipeline(clientId: string, text: string): Promise<void> {
  await sendCommand(clientId, { type: "stt", payload: { text } });
  await persistConversationTurn(clientId, text);

  let deviceId = clientId;
  try {
    const device = await db.device.findFirst({
      where: { OR: [{ clientId }, { deviceId: clientId }] },
    });
    if (device) deviceId = device.clientId;
  } catch (err) {
    console.error("[Converse] failed to resolve device:", err);
  }

  await sendCommand(clientId, {
    type: "tts",
    payload: { state: "thinking" },
  });

  if (process.env.XIAOZHI_STREAM_REPLY === "true" && process.env.XIAOZHI_DISABLE_STREAM_REPLY !== "true") {
    try {
      await streamReplyPipeline(clientId, text, deviceId);
      return;
    } catch (err) {
      console.error(
        `[Converse] streaming pipeline failed for ${clientId}, falling back to batch:`,
        err,
      );
    }
  }

  let reply: string;
  let emotionLabel = "neutral";
  try {
    const outcome = await chatService.handle({ prompt: text }, deviceId);
    if (outcome.kind === "ok" || outcome.kind === "fallback") {
      reply = outcome.reply.reply;
      if (outcome.kind === "ok") emotionLabel = outcome.emotion;
    } else {
      console.error("[Converse] chat service error:", outcome.reason);
      reply = "抱歉,AI 服务暂时不可用。";
    }
    console.log(`[Converse] agent replied ${reply.length} chars`);
  } catch (err) {
    console.error("[Converse] agent failed:", err);
    reply = "抱歉,AI 服务暂时不可用。";
  }

  await speakReply(clientId, reply, emotionLabel);
  await persistAssistantReply(clientId, reply);
}

async function persistConversationTurn(clientId: string, text: string): Promise<void> {
  try {
    const device = await db.device.findFirst({
      where: { OR: [{ clientId }, { deviceId: clientId }] },
    });
    if (!device) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    await appendMessage(device.clientId, "user", trimmed);
  } catch (err) {
    console.error(`[Converse] persist user message failed for ${clientId}:`, err);
  }
}

async function persistAssistantReply(clientId: string, reply: string): Promise<void> {
  try {
    const device = await db.device.findFirst({
      where: { OR: [{ clientId }, { deviceId: clientId }] },
    });
    if (!device) return;
    const trimmed = reply.trim();
    if (!trimmed) return;
    await appendMessage(device.clientId, "assistant", trimmed);
  } catch (err) {
    console.error(`[Converse] persist assistant message failed for ${clientId}:`, err);
  }
}

async function streamReplyPipeline(
  clientId: string,
  text: string,
  deviceId: string,
): Promise<void> {
  console.log(`[Converse] stream: start ${clientId}`);
  await sendCommand(clientId, { type: "tts", payload: { state: "start" } });

  // Streaming TTS is currently known to return control events without audio
  // for this voice; `speakFullReply` uses the reliable short-lived batch path.
  // Do not block first-token delivery on a long-lived session handshake that
  // cannot produce audio on this path.
  const pipeline: { tts: DoubaoStreamingTTS; encoder: OpusEncoder } | null = null;
  let emotionLabel = "neutral";
  try {
    const contextStartedAt = Date.now();
    console.log(`[Converse] stream: buildAgentOpts ${clientId}`);
    const opts = await buildAgentOpts(text, deviceId);
    emotionLabel = opts.emotion;
    console.log(`[Latency] ${clientId} context_ready_ms=${Date.now() - contextStartedAt}`);

    let prevText = "";
    let fullText = "";
    // Number of TTS requests issued for this reply. Always 0 or 1 now that
    // the server no longer splits the LLM output into sentences.
    let ttsRequests = 0;
    let totalOpusBytes = 0;
    const generationStartedAt = Date.now();
    let firstTextAt: number | null = null;
    let firstAudioAt: number | null = null;

    const { callAgentWithToolsStreaming } = await import(
      "@/services/ai"
    );
    console.log(`[Converse] stream: callAgentWithToolsStreaming begin ${clientId}`);
    let chunkCount = 0;
    // Watchdog: if the LLM stream hangs (model cold-load, Ollama stalled,
    // network dead, no chunks ever arriving), abandon the stream and
    // throw so the outer fallback tries the batch path. Otherwise the
    // device sees a silent hang with no audio and no error.
    // `deepagents` streams graph-state snapshots rather than raw provider
    // tokens. A local Ollama turn can legitimately spend tens of seconds in a
    // tool/agent step between snapshots, especially while the model is warm or
    // generating a long tool decision. The old 30s default therefore aborted
    // healthy local turns and immediately started a second batch request.
    const { getActiveProviderName } = await import("@/services/ai/provider-store");
    const activeProvider = await getActiveProviderName();
    const localOllama = activeProvider === "local";
    const LLM_FIRST_CHUNK_TIMEOUT_MS = Number(
      process.env.XIAOZHI_LLM_FIRST_CHUNK_TIMEOUT_MS || (localOllama ? 120_000 : 60_000),
    );
    const LLM_CHUNK_TIMEOUT_MS = Number(
      process.env.XIAOZHI_LLM_CHUNK_TIMEOUT_MS || (localOllama ? 120_000 : 45_000),
    );
    console.log(`[Converse] stream watchdog provider=${activeProvider} first=${LLM_FIRST_CHUNK_TIMEOUT_MS}ms idle=${LLM_CHUNK_TIMEOUT_MS}ms ${clientId}`);
    const sourceIter = callAgentWithToolsStreaming(text, opts)[Symbol.asyncIterator]();
    let watchdog: NodeJS.Timeout | null = null;
    const watchdogArmed = () =>
      new Promise<never>((_, reject) => {
        const ms = chunkCount === 0
          ? LLM_FIRST_CHUNK_TIMEOUT_MS
          : LLM_CHUNK_TIMEOUT_MS;
        watchdog = setTimeout(() => {
          reject(new Error(
            `LLM stream stall: no chunk for ${ms}ms (got ${chunkCount} so far)`,
          ));
        }, ms);
      });
    try {
      while (true) {
        const raceResult = await Promise.race([
          sourceIter.next(),
          watchdogArmed(),
        ]);
        if (watchdog) {
          clearTimeout(watchdog);
          watchdog = null;
        }
        if (raceResult.done) break;
        const chunk = raceResult.value;
        chunkCount++;
        if (chunkCount === 1 || chunkCount % 5 === 0) {
          console.log(
            `[Converse] stream: chunk #${chunkCount} contentLen=${chunk.content.length} msgs=${chunk.messages?.length ?? 0} ${clientId}`,
          );
        }
        // Pull the assistant message we want to stream to the user:
        // pickFinalAssistantText filters out intermediate tool-call turns.
        const currentText = pickFinalAssistantText(chunk.messages ?? []);
        if (currentText.length <= prevText.length) continue;
        const delta = currentText.slice(prevText.length);
        if (firstTextAt === null) {
          firstTextAt = Date.now();
          console.log(`[Latency] ${clientId} llm_first_text_ms=${firstTextAt - generationStartedAt}`);
        }
        prevText = currentText;
        fullText += delta;

        // The whole reply is sent to TTS in a single request after the stream
        // finishes. We deliberately do NOT slice the LLM output into
        // sentences: the firmware drives playback itself, and one request per
        // reply keeps the TTS session and the device state machine in sync.
      }
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
    console.log(
      `[Converse] stream: LLM stream ended (${chunkCount} chunks, ${fullText.length} chars) ${clientId}`,
    );

    // Hand the entire reply to TTS exactly once.
    const finalText = fullText.trim();
    if (finalText.length > 0) {
      ttsRequests = 1;
      const ttsStartedAt = Date.now();
      await speakFullReply(
        clientId,
        finalText,
        (n) => {
          totalOpusBytes += n;
          if (n > 0 && firstAudioAt === null) {
            firstAudioAt = Date.now();
            console.log(
              `[Latency] ${clientId} first_audio_ready_ms=${firstAudioAt - generationStartedAt}` +
              ` tts_synthesis_ms=${firstAudioAt - ttsStartedAt}`,
            );
          }
        },
      );
    }

    await sendCommand(clientId, {
      type: "llm",
      payload: { emotion: toDeviceEmotion(emotionLabel), text: fullText },
    });

    await sendCommand(clientId, {
      type: "mcp",
      payload: {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: {
          emotion: emotionLabel,
          text: fullText,
          tts_ok: pipeline !== null,
          opus_bytes: totalOpusBytes,
          streaming: true,
        },
      },
    });

    await writeAudit({
      actor: "device",
      actorId: clientId,
      action: "converse.reply",
      target: `device:${clientId}`,
      payload: {
        emotion: emotionLabel,
        length: fullText.length,
        tts_requests: ttsRequests,
        tts_ok: pipeline !== null,
        opus_bytes: totalOpusBytes,
        streaming: true,
      },
    });

    console.log(
      `[Converse] stream reply done (${fullText.length} chars, ${ttsRequests} tts request(s), ${totalOpusBytes}B opus)`,
    );
  } finally {
    // Intentionally NOT closing the TTS pipeline here — it persists for
    // the next reply. closeSession/abort invalidate it explicitly.
    await sendCommand(clientId, { type: "tts", payload: { state: "stop" } });
  }
}

async function speakFullReply(
  clientId: string,
  text: string,
  onOpusBytes: (n: number) => void,
): Promise<void> {
  console.log(
    `[Converse] speakFullReply: start textLen=${text.length} ${clientId}`,
  );
  await sendCommand(clientId, {
    type: "tts",
    payload: { state: "sentence_start", text },
  });

  let bytes = 0;
  let count = 0;

  try {
    // The streaming long-lived TTS path silently produces 0 audio chunks
    // for this voice — Doubao's bidirectional session replies with
    // SentenceStart/SentenceEnd but never with audio. Fall back to the
    // batch synthesize path (fresh short-lived WS) which is known to
    // work. We still keep the shared OpusEncoder so the ffmpeg process
    // and frame extraction stay warm across sentences.
    const ttsResult = await ttsSynthesize({ text });
    console.log(
      `[Converse] speakFullReply: batch synthesized ${ttsResult.oggOpus.length} bytes opus ${clientId}`,
    );
    const frames = extractOpusPacketsFromOgg(ttsResult.oggOpus);
    const startAt = Date.now();
    for (let i = 0; i < frames.length; i++) {
      const wait = startAt + i * OPUS_FRAME_MS - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      await sendAudioToClient(clientId, frames[i]);
      bytes += frames[i].length;
      count++;
    }
    console.log(
      `[Converse] speakFullReply: done (opusFrames=${count} opusBytes=${bytes}) ${clientId}`,
    );
    onOpusBytes(bytes);
  } catch (err) {
    console.error(
      `[Converse] speakFullReply: TTS failed (opusFrames=${count}) ${clientId}:`,
      err,
    );
    onOpusBytes(0);
  }
}
 


async function runReplyPipelineGuarded(clientId: string, text: string): Promise<void> {
  replyInFlight().set(clientId, true);
  try {
    await runReplyPipeline(clientId, text);
  } finally {
    replyInFlight().set(clientId, false);
    // A device may have requested auto-listening while audio was still being
    // generated/played. Resume exactly once after tts:stop, rather than
    // racing a fresh ASR session against the reply audio.
    const mode = pendingListen().get(clientId);
    pendingListen().delete(clientId);
    if (mode) {
      console.log(`[Converse] resuming deferred listen for ${clientId} mode=${mode}`);
      void startListening(clientId, mode);
    }
  }
}

export async function sendGreeting(clientId: string): Promise<void> {
  const greeting = process.env.XIAOZHI_GREETING ?? "我在，有什么可以帮你？";
  replyInFlight().set(clientId, true);
  try {
    await speakReply(clientId, greeting, "happy");
  } catch (err) {
    console.error(`[Converse] greeting failed for ${clientId}:`, err);
  } finally {
    replyInFlight().set(clientId, false);
  }
}

export async function abort(clientId: string, reason: string): Promise<void> {
  clearFrames(clientId);
  sessions().delete(clientId);
  audioBuffers().delete(clientId);

  // Clean up streaming ASR
  const session = streamingSessions().get(clientId);
  if (session) {
    try { await session.finish(); } catch {}
    streamingSessions().delete(clientId);
  }
  streamingFinalTexts().delete(clientId);

  await invalidateTtsPipeline(clientId);

  await sendCommand(clientId, {
    type: "tts",
    payload: { state: "stop" },
  });
  await writeAudit({
    actor: "device",
    actorId: clientId,
    action: "converse.abort",
    target: `device:${clientId}`,
    payload: { reason },
  });
}

export async function closeSession(clientId: string): Promise<void> {
  clearFrames(clientId);
  audioBuffers().delete(clientId);
  sessions().delete(clientId);

  const session = streamingSessions().get(clientId);
  if (session) {
    try { await session.finish(); } catch {}
    streamingSessions().delete(clientId);
  }
  streamingFinalTexts().delete(clientId);

  await invalidateTtsPipeline(clientId);
}
