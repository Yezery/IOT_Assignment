import { z } from "zod";

/**
 * xiaozhi-esp32 wire-protocol constants and Zod schemas.
 *
 * Every constant here mirrors the on-wire shape documented in
 * `xiaozhi-esp32/docs/xiaozhi-network-integration.md` §2.5 / §3.3.
 * If the firmware changes shape, change it here first and let TypeScript
 * catch every caller.
 */

export const LISTEN_STATES = ["start", "stop", "detect"] as const;
export const LISTEN_MODES = ["auto", "manual", "realtime"] as const;
export const TTS_STATES = ["start", "stop", "sentence_start"] as const;
export const TRANSPORTS = ["websocket", "udp"] as const;
export const GOODBYE_REASONS = ["server_initiated"] as const;
export const AUDIO_ENCODINGS = ["opus"] as const;

export const Hello = z.object({
  type: z.literal("hello"),
  version: z.number().int().nonnegative().optional(),
  transport: z.string().optional(),
  features: z.record(z.string(), z.unknown()).optional(),
  audio_params: z
    .object({
      format: z.string().optional(),
      sample_rate: z.number().int().positive().optional(),
      channels: z.number().int().positive().optional(),
      frame_duration: z.number().int().positive().optional(),
    })
    .optional(),
  text_font: z.record(z.string(), z.unknown()).optional(),
});

export const Listen = z.object({
  type: z.literal("listen"),
  session_id: z.string().optional(),
  state: z.enum(LISTEN_STATES),
  mode: z.enum(LISTEN_MODES).optional(),
  text: z.string().optional(),
});

export const Abort = z.object({
  type: z.literal("abort"),
  session_id: z.string().optional(),
  reason: z.string().optional(),
});

export const McpEnvelope = z.object({
  type: z.literal("mcp"),
  session_id: z.string().optional(),
  payload: z.unknown(),
});

export const Goodbye = z.object({
  type: z.literal("goodbye"),
  session_id: z.string().optional(),
});

export const Heartbeat = z.object({
  type: z.literal("heartbeat"),
  session_id: z.string().optional(),
});

export const Stt = z.object({
  type: z.literal("stt"),
  session_id: z.string().optional(),
  text: z.string(),
});

export const Tts = z.object({
  type: z.literal("tts"),
  session_id: z.string().optional(),
  state: z.enum(TTS_STATES),
  text: z.string().optional(),
});

export const Llm = z.object({
  type: z.literal("llm"),
  session_id: z.string().optional(),
  emotion: z.string(),
  text: z.string().optional(),
});

export const SystemMessage = z.object({
  type: z.literal("system"),
  session_id: z.string().optional(),
  command: z.string(),
});

export const Alert = z.object({
  type: z.literal("alert"),
  session_id: z.string().optional(),
  status: z.string(),
  message: z.string(),
  emotion: z.string(),
});

export const Notify = z.object({
  type: z.literal("notify"),
  audio_url: z.string().url(),
  subtitles: z
    .array(z.object({ start_ms: z.number().int().nonnegative(), text: z.string() }))
    .optional(),
});

/**
 * Device → Server audio frame (Opus). The payload is base64-encoded.
 * Used when the audio channel is carried over MQTT instead of UDP.
 */
export const AudioFrame = z.object({
  type: z.literal("audio"),
  session_id: z.string().optional(),
  encoding: z.enum(AUDIO_ENCODINGS),
  frame_duration_ms: z.number().int().positive().optional(),
  data_b64: z.string().min(1),
});

export const IncomingMessage = z.discriminatedUnion("type", [
  Hello,
  Listen,
  Abort,
  McpEnvelope,
  Goodbye,
  Heartbeat,
  Stt,
  Tts,
  Llm,
  SystemMessage,
  Alert,
  Notify,
  AudioFrame,
]);

export type IncomingMessage = z.infer<typeof IncomingMessage>;
export type Hello = z.infer<typeof Hello>;
export type Listen = z.infer<typeof Listen>;
export type Abort = z.infer<typeof Abort>;
export type McpEnvelope = z.infer<typeof McpEnvelope>;
export type Goodbye = z.infer<typeof Goodbye>;
export type Heartbeat = z.infer<typeof Heartbeat>;
export type Stt = z.infer<typeof Stt>;
export type Tts = z.infer<typeof Tts>;
export type Llm = z.infer<typeof Llm>;
export type SystemMessage = z.infer<typeof SystemMessage>;
export type Alert = z.infer<typeof Alert>;
export type Notify = z.infer<typeof Notify>;
export type AudioFrame = z.infer<typeof AudioFrame>;

export const JsonRpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z.unknown().optional(),
});

export const JsonRpcNotification = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
});

export const JsonRpcResult = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  result: z.unknown(),
});

export const JsonRpcError = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  error: z.object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  }),
});

export type JsonRpcRequest = z.infer<typeof JsonRpcRequest>;
export type JsonRpcNotification = z.infer<typeof JsonRpcNotification>;
export type JsonRpcResult = z.infer<typeof JsonRpcResult>;
export type JsonRpcError = z.infer<typeof JsonRpcError>;
