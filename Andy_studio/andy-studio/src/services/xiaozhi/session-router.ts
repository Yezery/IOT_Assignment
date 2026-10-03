import {
  startListening,
  stopListening,
  handleStt,
  sendGreeting,
  abort,
  closeSession,
  ingestAudioFrame,
  finalizeUtterance,
} from "./converse";
import { writeAudit } from "./audit";
import { publishToDevice } from "@/lib/xiaozhi/client";
import { registerUdpClientPre, hasUdpClient, resetUdpClient } from "@/lib/xiaozhi/udp-server";
import { setDeviceSessionId, getDeviceSessionId, hasDeviceSessionId } from "./commands";
import type { IncomingMessage } from "./protocol";
import { randomBytes } from "node:crypto";

function makeUdpKey(): { key: string; nonce: string } {
  return {
    key: randomBytes(16).toString("hex"),
    nonce: randomBytes(16).toString("hex"),
  };
}

async function sendHello(clientId: string): Promise<void> {
  const sessionId = hasDeviceSessionId(clientId)
    ? getDeviceSessionId(clientId)
    : crypto.randomUUID();
  const { key, nonce } = makeUdpKey();
  const serverHost = process.env.XIAOZHI_UDP_HOST || "127.0.0.1";
  const serverPort = parseInt(process.env.XIAOZHI_UDP_PORT || "18888", 10);

  resetUdpClient(clientId);
  registerUdpClientPre(clientId, key);
  setDeviceSessionId(clientId, sessionId);

  await publishToDevice(clientId, {
    type: "hello",
    version: 3,
    transport: "udp",
    session_id: sessionId,
    audio_params: {
      format: "opus",
      sample_rate: 16000,
      channels: 1,
      frame_duration: 60,
    },
    udp: {
      server: serverHost,
      port: serverPort,
      key,
      nonce,
    },
  });
}

async function ensureUdpChannel(clientId: string): Promise<void> {
  if (hasUdpClient(clientId)) return;
  console.log(`[Xiaozhi] no UDP channel for ${clientId}, sending fresh hello to re-key`);
  await sendHello(clientId);
}

export const sessionRouter = {
  async dispatch(clientId: string, msg: IncomingMessage): Promise<void> {
    switch (msg.type) {
      case "hello": {
        await sendHello(clientId);

        await writeAudit({
          actor: "device",
          actorId: clientId,
          action: "device.hello",
          target: `device:${clientId}`,
          payload: { transport: "udp" },
        });
        return;
      }
      case "listen":
        if (msg.state === "start") {
          await ensureUdpChannel(clientId);
          await startListening(clientId, msg.mode ?? "manual");
        } else if (msg.state === "stop") {
          await stopListening(clientId);
          await finalizeUtterance(clientId);
        } else if (msg.state === "detect") {
          await ensureUdpChannel(clientId);
          await startListening(clientId, "auto");
          void sendGreeting(clientId);
        }
        return;

      case "audio":
        ingestAudioFrame(clientId, msg.data_b64);
        return;

      case "stt":
        await handleStt(clientId, msg.text);
        return;

      case "abort":
        await abort(clientId, msg.reason ?? "device_initiated");
        return;

      case "goodbye":
        // Device may send goodbye without listen{state:"stop"} first (e.g. timeout,
        // network event). Finalize any pending audio so ASR + reply pipeline still runs.
        await stopListening(clientId);
        await finalizeUtterance(clientId);
        await closeSession(clientId);
        return;

      case "heartbeat":
        return;

      case "system":
        await writeAudit({
          actor: "device",
          actorId: clientId,
          action: "device.system",
          target: `device:${clientId}`,
          payload: { command: msg.command },
        });
        return;

      case "alert":
        await writeAudit({
          actor: "device",
          actorId: clientId,
          action: "device.alert",
          target: `device:${clientId}`,
          payload: { status: msg.status, message: msg.message, emotion: msg.emotion },
        });
        return;

      default:
        await writeAudit({
          actor: "device",
          actorId: clientId,
          action: `device.${msg.type}`,
          target: `device:${clientId}`,
          payload: msg as unknown as Record<string, unknown>,
        });
        return;
    }
  },
};
