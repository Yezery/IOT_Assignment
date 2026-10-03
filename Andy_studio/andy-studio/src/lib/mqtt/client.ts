/**
 * MQTT client wrapper for the Andy Studio dashboard.
 *
 * Responsibilities:
 *   1. Maintain a single long-lived connection to EMQX Cloud (TLS).
 *   2. Subscribe to `device/+/status` and `device/+/chat/request`.
 *   3. Dispatch incoming messages by topic family:
 *        - status  → device store
 *        - chat    → chat service → LLM → publish response
 *   4. Surface connection lifecycle via structured console logs.
 *
 * Lifecycle:
 *   The MQTT client is lazily created on first call to `getMqttClient()`,
 *   which is invoked from `instrumentation.ts` at server boot. The
 *   `globalThis` storage keeps the singleton alive across HMR reloads.
 */

import type { MqttClient, IClientOptions, IClientPublishOptions } from "mqtt";

import { env, buildMqttBrokerUrl } from "@/lib/env";
import {
  parseDeviceStatusMessage,
  extractDeviceIdFromStatusTopic,
} from "@/lib/device/parse";
import {
  parseChatRequest,
  extractDeviceIdFromChatRequestTopic,
} from "@/lib/device/chat-parse";
import { upsertDevice } from "@/lib/device/store";
import { chatService, buildFallbackReply } from "@/services/chat-service";

declare global {
  var __andyMqttClient: MqttClient | undefined;
  var __andyMqttStarted: boolean | undefined;
}

function buildClientId(): string {
  if (env.mqtt.clientId) return env.mqtt.clientId;
  const host = process.env.HOSTNAME ?? "localhost";
  return `andy-studio-${host}-${Date.now()}`;
}

function buildConnectOptions(): IClientOptions {
  const opts: IClientOptions = {
    clientId: buildClientId(),
    protocolVersion: 5,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 30_000,
    keepalive: 60,
    resubscribe: true,
    username: env.mqtt.username || undefined,
    password: env.mqtt.password || undefined,
  };

  if (env.mqtt.broker.startsWith("mqtts://") || env.mqtt.port === 8883) {
    opts.rejectUnauthorized = env.mqtt.rejectUnauthorized;
  }

  return opts;
}

function topicFamily(topic: string): "status" | "chat" | "unknown" {
  const statusId = extractDeviceIdFromStatusTopic(topic);
  if (statusId !== null) return "status";
  if (extractDeviceIdFromChatRequestTopic(topic) !== null) return "chat";
  return "unknown";
}

function handleStatusMessage(topic: string, payload: Buffer): void {
  const text = payload.toString("utf8");
  const fallbackId = extractDeviceIdFromStatusTopic(topic) ?? undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn("[MQTT] Invalid message: payload is not valid JSON");
    return;
  }

  const result = parseDeviceStatusMessage(parsed, fallbackId);
  if (!result.ok) {
    console.warn(`[MQTT] Ignored message: ${result.reason}`);
    return;
  }
  upsertDevice(result.status);
}

async function handleChatMessage(
  topic: string,
  payload: Buffer,
): Promise<void> {
  const text = payload.toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn("[MQTT] Invalid chat request: payload is not valid JSON");
    return;
  }

  const result = parseChatRequest(parsed);
  if (!result.ok) {
    console.warn(`[MQTT] ${result.reason}`);
    return;
  }

  console.log(
    `[MQTT] Chat request received\n  topic:   ${topic}\n` +
      `  prompt:  ${result.request.prompt}`,
  );

  try {
    const deviceId = extractDeviceIdFromChatRequestTopic(topic) ?? undefined;
    const outcome = await chatService.handle(result.request, deviceId);
    const reply =
      outcome.kind === "ok" || outcome.kind === "fallback"
        ? outcome.reply
        : buildFallbackReply();
    await publishChatReply(topic, reply.reply);
  } catch (err) {
    console.error("[MQTT] Chat handler crashed:", err);
  }
}

async function publishChatReply(
  requestTopic: string,
  replyText: string,
): Promise<void> {
  // Reply topic mirrors the request topic's device segment, e.g.
  //   device/esp32-001/chat/request → device/esp32-001/chat/reply
  const replyTopic = requestTopic.replace(/\/request$/, "/reply");
  const payload = JSON.stringify({ reply: replyText });
  console.log(`[MQTT] Publishing reply\n  topic:   ${replyTopic}\n  reply:   ${replyText}`);
  // Chat replies are NOT retained — they are bound to a single request.
  await publish(replyTopic, payload, { qos: 1, retain: false });
}

function attachLifecycleListeners(client: MqttClient): void {
  client.on("connect", () => {
    console.log("[MQTT] Connected");

    client.subscribe(env.mqtt.statusTopic, { qos: 1 }, (err) => {
      if (err) {
        console.error(`[MQTT] Subscribe failed (status): ${err.message}`);
      } else {
        console.log(`[MQTT] Subscribed: ${env.mqtt.statusTopic}`);
      }
    });

    client.subscribe(env.mqtt.chatRequestTopic, { qos: 1 }, (err) => {
      if (err) {
        console.error(`[MQTT] Subscribe failed (chat): ${err.message}`);
      } else {
        console.log(`[MQTT] Subscribed: ${env.mqtt.chatRequestTopic}`);
      }
    });
  });

  client.on("reconnect", () => {
    console.log("[MQTT] Reconnecting...");
  });

  client.on("close", () => {
    console.log("[MQTT] Connection closed");
  });

  client.on("offline", () => {
    console.warn("[MQTT] Client offline");
  });

  client.on("error", (err) => {
    console.error(`[MQTT] Error: ${err.message}`);
  });

  client.on("message", (topic, payload, packet) => {
    console.log(
      `[MQTT] Message received\n  topic:   ${topic}\n` +
        `  payload: ${payload.toString("utf8")}\n` +
        `  retain:  ${packet.retain}`,
    );

    switch (topicFamily(topic)) {
      case "status":
        handleStatusMessage(topic, payload);
        break;
      case "chat":
        void handleChatMessage(topic, payload);
        break;
      default:
        console.warn(`[MQTT] Unhandled topic: ${topic}`);
    }
  });
}

/**
 * Return the process-wide MQTT client, creating it on first call.
 *
 * Safe to call repeatedly: only the first call instantiates a connection.
 */
export async function getMqttClient(): Promise<MqttClient> {
  if (!globalThis.__andyMqttClient) {
    const url = buildMqttBrokerUrl();
    console.log(`[MQTT] Connecting to ${url} as ${buildClientId()}`);

    // Dynamic import keeps `mqtt` out of any future Edge bundle.
    const mqtt = (await import("mqtt")).default;
    const client = mqtt.connect(url, buildConnectOptions());

    attachLifecycleListeners(client);
    globalThis.__andyMqttClient = client;
  }
  return globalThis.__andyMqttClient;
}

/**
 * Ensure the client has been instantiated. Idempotent.
 *
 * Called from `src/lib/mqtt/startup.ts`. Splitting this out lets tests
 * and tooling trigger MQTT startup without going through Next.js.
 */
export async function ensureMqttStarted(): Promise<void> {
  if (globalThis.__andyMqttStarted) return;
  await getMqttClient();
  globalThis.__andyMqttStarted = true;
}

/**
 * Publish a message to a topic.
 *
 * `options.retain` defaults to `false` so callers must opt-in to retained
 * messages (only status wants them).
 */
export async function publish(
  topic: string,
  payload: string | Buffer,
  options: IClientPublishOptions = {},
): Promise<void> {
  const client = await getMqttClient();
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: 1, retain: false, ...options }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Gracefully close the MQTT connection (used by server shutdown / tests).
 */
export async function closeMqttClient(): Promise<void> {
  const client = globalThis.__andyMqttClient;
  if (!client) return;
  await new Promise<void>((resolve) => {
    client.end(false, {}, () => resolve());
  });
  globalThis.__andyMqttClient = undefined;
  globalThis.__andyMqttStarted = false;
  console.log("[MQTT] Client ended");
}
