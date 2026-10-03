import { publishToDevice } from "@/lib/xiaozhi/client";
import { writeAudit } from "./audit";

declare global {
  var __xiaozhiSessionIds: Map<string, string> | undefined;
}

function sessionIds(): Map<string, string> {
  if (!globalThis.__xiaozhiSessionIds) globalThis.__xiaozhiSessionIds = new Map();
  return globalThis.__xiaozhiSessionIds;
}

export function setDeviceSessionId(clientId: string, sessionId: string): void {
  sessionIds().set(clientId, sessionId);
}

export function hasDeviceSessionId(clientId: string): boolean {
  return sessionIds().has(clientId);
}

export function getDeviceSessionId(clientId: string): string {
  return sessionIds().get(clientId) ?? clientId;
}

export type CommandMessage =
  | { type: "system"; command: string }
  | { type: "tts"; state: "start" | "stop" | "sentence_start" | "thinking"; text?: string }
  | { type: "stt"; text: string }
  | { type: "alert"; status: string; message: string; emotion: string }
  | { type: "mcp"; payload: unknown }
  | { type: "llm"; emotion: string; text?: string }
  | { type: "notify"; audio_url: string; subtitles?: Array<{ start_ms: number; text: string }> }
  | { type: "goodbye"; session_id: string };

export type CommandInput = {
  type: CommandMessage["type"];
  payload?: Record<string, unknown>;
};

export async function sendCommand(
  clientId: string,
  input: CommandInput,
  actor?: { userId: string; role: "admin" | "operator" },
): Promise<void> {
  const sessionId = clientId;
  let body: Record<string, unknown>;
  switch (input.type) {
    case "system":
      body = { type: "system", command: String(input.payload?.command ?? "reboot") };
      break;
    case "tts": {
      const state = input.payload?.state;
      if (state !== "start" && state !== "stop" && state !== "sentence_start" && state !== "thinking") {
        throw new Error(`tts.state must be start|stop|sentence_start|thinking, got ${state}`);
      }
      body = { type: "tts", state, text: input.payload?.text, session_id: sessionId };
      break;
    }
    case "stt":
      body = { type: "stt", text: String(input.payload?.text ?? "") };
      break;
    case "alert":
      body = {
        type: "alert",
        status: String(input.payload?.status ?? ""),
        message: String(input.payload?.message ?? ""),
        emotion: String(input.payload?.emotion ?? "neutral"),
        session_id: sessionId,
      };
      break;
    case "mcp":
      body = { type: "mcp", payload: input.payload, session_id: sessionId };
      break;
    case "llm":
      body = {
        type: "llm",
        emotion: String(input.payload?.emotion ?? "neutral"),
        ...(input.payload?.text ? { text: String(input.payload.text) } : {}),
      };
      break;
    case "notify":
      body = {
        type: "notify",
        audio_url: String(input.payload?.audio_url ?? ""),
        subtitles: input.payload?.subtitles,
      };
      break;
    case "goodbye":
      body = { type: "goodbye", session_id: getDeviceSessionId(clientId) };
      console.log(`[commands] goodbye session_id=${String(body.session_id)} for ${clientId}`);
      break;
    default:
      throw new Error(`unsupported command type: ${(input as { type: string }).type}`);
  }

  await publishToDevice(clientId, body);
  console.log(`[commands] published ${input.type} to ${clientId}`);

  await writeAudit({
    actor: "user",
    actorId: actor?.userId,
    action: `command.${input.type}`,
    target: `device:${clientId}`,
    payload: body,
  });
}
