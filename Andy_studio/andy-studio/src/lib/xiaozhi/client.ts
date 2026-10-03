import mqtt from "mqtt";
import type { MqttClient, IClientPublishOptions } from "mqtt";
import { buildXiaozhiBrokerUrl, env } from "@/lib/env";
import { IncomingMessage } from "@/services/xiaozhi/protocol";
import { sessionRouter } from "@/services/xiaozhi/session-router";
import { redis } from "@/storage/redis";
import { upsertDevice } from "@/lib/device/store";
import { db } from "@/storage/db";

declare global {
  var __xiaozhiMqtt: MqttClient | undefined;
  var __xiaozhiMqttStarted: boolean | undefined;
}

const MESSAGES_TOPIC = (clientId: string) => `device/${clientId}/messages`;

// ── Self-publish loop guard ──────────────────────────────────────────
// EMQX echoes published messages back to the publisher when it is
// subscribed to the same topic.  We track recently published payloads
// per topic and skip the echoed copy in handleIncoming.
const recentlyPublished = new Map<string, Set<string>>();
const PUBLISH_TTL_MS = 3_000;

function payloadHash(buf: Buffer): string {
  // fast DJB2-style hash — good enough for dedup
  let h = 5381;
  for (let i = 0; i < buf.length; i++) {
    h = ((h << 5) + h + buf[i]) | 0;
  }
  return h.toString(36);
}

function markPublished(topic: string, payload: Buffer): void {
  const h = payloadHash(payload);
  let set = recentlyPublished.get(topic);
  if (!set) {
    set = new Set();
    recentlyPublished.set(topic, set);
  }
  set.add(h);
  setTimeout(() => {
    set?.delete(h);
    if (set && set.size === 0) recentlyPublished.delete(topic);
  }, PUBLISH_TTL_MS);
}

function isSelfPublished(topic: string, payload: Buffer): boolean {
  const h = payloadHash(payload);
  const set = recentlyPublished.get(topic);
  if (set?.has(h)) {
    set.delete(h);
    if (set.size === 0) recentlyPublished.delete(topic);
    return true;
  }
  return false;
}

function extractClientId(topic: string): string | null {
  const parts = topic.split("/");
  if (parts.length !== 3) return null;
  if (parts[0] !== "device" || parts[2] !== "messages") return null;
  return parts[1] || null;
}

function touchDevice(clientId: string): void {
  upsertDevice({ deviceId: clientId, status: "online", lastSeen: Date.now() });
  db.device
    .updateMany({
      where: { OR: [{ clientId }, { deviceId: clientId }] },
      data: { lastSeenAt: new Date() },
    })
    .catch(() => {});
}

async function handleIncoming(topic: string, payload: Buffer): Promise<void> {
  // Skip our own echoed publish
  if (isSelfPublished(topic, payload)) return;

  const clientId = extractClientId(topic);
  if (!clientId) {
    console.warn(`[XiaozhiMQTT] unhandled topic: ${topic}`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    console.warn(`[XiaozhiMQTT] invalid JSON on ${topic}`);
    return;
  }

  const result = IncomingMessage.safeParse(parsed);
  if (!result.success) {
    console.warn(
      `[XiaozhiMQTT] schema reject on ${topic}:`,
      result.error.issues[0]?.message,
    );
    return;
  }

  touchDevice(clientId);

  try {
    await redis.hset(`device:${clientId}:state`, {
      last_ping: Date.now().toString(),
    });
  } catch {}

  const summary =
    result.data.type === "listen"
      ? `listen/${result.data.state}`
      : result.data.type === "stt"
        ? `stt "${result.data.text}"`
        : result.data.type;
  console.log(`[XiaozhiMQTT] ${clientId.slice(0, 8)} ← ${summary}`);

  await sessionRouter.dispatch(clientId, result.data);
}

function attachListeners(client: MqttClient): void {
  client.on("connect", () => {
    console.log("[XiaozhiMQTT] Connected");
    client.subscribe("device/+/messages", { qos: 1 }, (err) => {
      if (err) {
        console.error(`[XiaozhiMQTT] subscribe failed: ${err.message}`);
      } else {
        console.log("[XiaozhiMQTT] Subscribed: device/+/messages");
      }
    });
  });

  client.on("reconnect", () => console.log("[XiaozhiMQTT] Reconnecting..."));
  client.on("close", () => console.log("[XiaozhiMQTT] Connection closed"));
  client.on("offline", () => console.warn("[XiaozhiMQTT] Client offline"));
  client.on("error", (err) => console.error(`[XiaozhiMQTT] Error: ${err.message}`));

  client.on("message", (topic, payload) => {
    void handleIncoming(topic, payload);
  });
}

export async function getXiaozhiMqttClient(): Promise<MqttClient> {
  if (globalThis.__xiaozhiMqtt) return globalThis.__xiaozhiMqtt;

  if (!env.xiaozhi.mqttBrokerHost) {
    throw new Error(
      "[XiaozhiMQTT] XIAOZHI_MQTT_BROKER is not set; gateway will not start.",
    );
  }

  const url = buildXiaozhiBrokerUrl();
  console.log(`[XiaozhiMQTT] Connecting to ${url} as ${env.xiaozhi.mqttClientId}`);

  const client = mqtt.connect(url, {
    clientId: env.xiaozhi.mqttClientId,
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 30_000,
    keepalive: 60,
    resubscribe: true,
    username: env.xiaozhi.mqttUsername || undefined,
    password: env.xiaozhi.mqttPassword || undefined,
  });

  attachListeners(client);
  globalThis.__xiaozhiMqtt = client;
  return client;
}

export async function ensureXiaozhiStarted(): Promise<void> {
  if (globalThis.__xiaozhiMqttStarted) return;
  try {
    await getXiaozhiMqttClient();
    globalThis.__xiaozhiMqttStarted = true;
  } catch (err) {
    console.error(`[XiaozhiMQTT] startup failed: ${(err as Error).message}`);
  }
}

export async function closeXiaozhiMqtt(): Promise<void> {
  const client = globalThis.__xiaozhiMqtt;
  if (!client) return;
  await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
  globalThis.__xiaozhiMqtt = undefined;
  globalThis.__xiaozhiMqttStarted = false;
  console.log("[XiaozhiMQTT] Client ended");
}

export async function publishToDevice(
  clientId: string,
  payload: object,
  options: IClientPublishOptions = {},
): Promise<void> {
  const client = await getXiaozhiMqttClient();
  const topic = MESSAGES_TOPIC(clientId);
  const buf = Buffer.from(JSON.stringify(payload));
  markPublished(topic, buf);
  return new Promise<void>((resolve) => {
    client.publish(topic, buf.toString("utf8"), { qos: 0, retain: false, ...options }, () => resolve());
  });
}

export { MESSAGES_TOPIC };
