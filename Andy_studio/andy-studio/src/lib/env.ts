/**
 * Centralized, type-safe access to environment variables.
 *
 * All env reads must go through this module so that:
 *  1. We get a single point of validation/fallback.
 *  2. We can statically reason about which vars exist.
 *  3. We avoid `process.env.X` sprinkled around the codebase.
 *
 * IMPORTANT: This module is server-only. Never import it from a Client Component.
 */

/** Parse a string-as-boolean env value. Defaults to `false` if missing/invalid. */
function parseBool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true" || value === "1";
}

export const env = {
  mqtt: {
    broker: process.env.MQTT_BROKER ?? "",
    port: Number.parseInt(process.env.MQTT_PORT ?? "8883", 10),
    username: process.env.MQTT_USERNAME ?? "",
    password: process.env.MQTT_PASSWORD ?? "",
    clientId: process.env.MQTT_CLIENT_ID ?? "",
    statusTopic: process.env.MQTT_TOPIC_STATUS ?? "device/+/status",
    chatRequestTopic:
      process.env.MQTT_TOPIC_CHAT_REQUEST ?? "device/+/chat/request",
    rejectUnauthorized: parseBool(process.env.MQTT_REJECT_UNAUTHORIZED, false),
  },
  llm: {
    apiKey: process.env.LLM_API_KEY ?? "",
    baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.LLM_MODEL ?? "gpt-4o-mini",
    timeoutMs: Number.parseInt(process.env.LLM_TIMEOUT_MS ?? "20000", 10),
    // 32 bytes (base64-encoded). Used to encrypt LLM provider API keys
    // at rest in Postgres. Generate one with:
    //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    encryptionKey: process.env.LLM_ENCRYPTION_KEY ?? "",
  },
  xiaozhi: {
    otaBaseUrl:
      process.env.XIAOZHI_OTA_BASE_URL ??
      process.env.NEXT_PUBLIC_BASE_URL ??
      "http://localhost:3000",

    mqttBrokerHost: process.env.XIAOZHI_MQTT_BROKER ?? "",
    mqttPort: Number.parseInt(process.env.XIAOZHI_MQTT_PORT ?? "8883", 10),
    mqttTls: parseBool(process.env.XIAOZHI_MQTT_TLS, true),
    mqttUsername: process.env.XIAOZHI_MQTT_USERNAME ?? "",
    mqttPassword: process.env.XIAOZHI_MQTT_PASSWORD ?? "",
    mqttClientId:
      process.env.XIAOZHI_MQTT_CLIENT_ID ?? `andy-studio-xiaozhi-${process.pid}`,

    wsUrl: process.env.XIAOZHI_WS_URL ?? "",

    jwtSecret:
      process.env.XIAOZHI_JWT_SECRET ??
      "dev-only-change-me-please-32-bytes-min",
    deviceTokenTtlDays: Number.parseInt(
      process.env.XIAOZHI_DEVICE_TOKEN_TTL_DAYS ?? "7",
      10,
    ),
    activationTtlMin: Number.parseInt(
      process.env.XIAOZHI_ACTIVATION_TTL_MIN ?? "10",
      10,
    ),

    doubao: {
      appId: process.env.DOUBAO_APP_ID ?? "",
      apiKey: process.env.DOUBAO_API_KEY ?? "",
      accessToken: process.env.DOUBAO_ACCESS_TOKEN ?? "",
      asrResourceId: (process.env.DOUBAO_ASR_RESOURCE_ID ?? "volc.seedasr.auc").trim(),
      ttsCluster: (process.env.DOUBAO_TTS_CLUSTER ?? "volcano_tts").trim(),
      ttsVoice: (process.env.DOUBAO_TTS_VOICE ?? "zh_female_xiaohe_uranus_bigtts").trim(),
      asrPollMs: Number.parseInt(process.env.DOUBAO_ASR_POLL_MS ?? "600", 10),
      asrMaxPolls: Number.parseInt(process.env.DOUBAO_ASR_MAX_POLLS ?? "30", 10),
      timeoutMs: Number.parseInt(process.env.DOUBAO_TIMEOUT_MS ?? "15000", 10),
    },
    ffmpegPath: process.env.FFMPEG_PATH ?? "/opt/homebrew/bin/ffmpeg",
  },
  knowledge: {
    type: ((process.env.knowledge_type ?? process.env.KNOWLEDGE_TYPE ?? "wiki").toLowerCase() === "rag"
      ? "rag"
      : "wiki") as "rag" | "wiki",
  },
} as const;

/**
 * Build the mqtts:// URL consumed by mqtt.js.
 * Throws if MQTT_BROKER is missing — fail fast at startup, not on first message.
 */
export function buildMqttBrokerUrl(): string {
  if (!env.mqtt.broker) {
    throw new Error(
      "[env] MQTT_BROKER is not set. Copy .env.example to .env.local and fill in your EMQX credentials.",
    );
  }
  return `mqtts://${env.mqtt.broker}:${env.mqtt.port}`;
}

/**
 * Build the mqtts:// URL consumed by mqtt.js for the xiaozhi broker.
 * Separate from the legacy `buildMqttBrokerUrl()` so the two brokers can
 * diverge (e.g., self-hosted EMQX for xiaozhi vs. EMQX Cloud for legacy).
 */
export function buildXiaozhiBrokerUrl(): string {
  if (!env.xiaozhi.mqttBrokerHost) {
    throw new Error(
      "[env] XIAOZHI_MQTT_BROKER is not set. The xiaozhi MQTT gateway will not start.",
    );
  }
  const scheme = env.xiaozhi.mqttTls ? "mqtts" : "mqtt";
  return `${scheme}://${env.xiaozhi.mqttBrokerHost}:${env.xiaozhi.mqttPort}`;
}
