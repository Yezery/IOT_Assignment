import { createHash, randomBytes } from "node:crypto";
import { db } from "@/storage/db";
import { env } from "@/lib/env";
import { issueDeviceToken } from "./tokens";
import { writeAudit } from "./audit";
import { ensureWorkspace } from "@/services/workspace";

export type DeviceSystemInfo = {
  version?: number;
  language?: string;
  flash_size?: number;
  minimum_free_heap_size?: number;
  mac_address: string;
  uuid: string;
  chip_model_name?: string;
  chip_info?: { model?: number; cores?: number; revision?: number; features?: number };
  application?: {
    name?: string;
    version?: string;
    compile_time?: string;
    idf_version?: string;
    elf_sha256?: string;
  };
  partition_table?: Array<{
    label?: string;
    type?: number;
    subtype?: number;
    address?: number;
    size?: number;
  }>;
  ota?: { label?: string };
  display?: { monochrome?: boolean; width?: number; height?: number };
  board?: Record<string, unknown>;
};

export type OtaResponse = {
  firmware?: {
    version: string;
    url: string;
    force?: number;
  };
  mqtt: {
    endpoint: string;
    client_id: string;
    username: string;
    password: string;
    keepalive: number;
    publish_topic: string;
  };
  websocket: {
    url: string;
    token: string;
    version: number;
  };
  server_time: {
    timestamp: number;
    timezone_offset?: number;
  };
  activation?: {
    code: string;
    message: string;
    challenge: string;
    timeout_ms: number;
  };
};

function makeActivationCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i === 3) out += "-";
  }
  return out;
}

async function pickFirmwareForDevice(device: {
  board: string;
  variant: string;
  clientId: string;
}): Promise<OtaResponse["firmware"] | undefined> {
  const releases = await db.firmwareRelease.findMany({
    where: { status: "published", board: device.board, variant: device.variant },
    orderBy: { publishedAt: "desc" },
  });
  for (const r of releases) {
    const rollout = (r.rollout ?? {}) as {
      strategy?: string;
      percent?: number;
      allowlist?: string[];
      denylist?: string[];
    };
    const strategy = rollout.strategy ?? "immediate";
    if (rollout.denylist?.includes(device.clientId)) continue;
    let eligible = false;
    if (strategy === "immediate") eligible = true;
    else if (strategy === "percentage") {
      const h = parseInt(
        createHash("sha256").update(device.clientId).digest("hex").slice(0, 8),
        16,
      );
      eligible = (h % 100) < (rollout.percent ?? 0);
    } else if (strategy === "allowlist") {
      eligible = rollout.allowlist?.includes(device.clientId) ?? false;
    } else if (strategy === "denylist_excluded") {
      eligible = true;
    }
    if (!eligible) continue;

    return {
      version: r.version,
      url: `${env.xiaozhi.otaBaseUrl}/api/v1/internal/firmware/${r.id}`,
      ...(r.force ? { force: 1 } : {}),
    };
  }
  return undefined;
}

async function buildActivation(devicePk: bigint): Promise<NonNullable<OtaResponse["activation"]>> {
  const code = makeActivationCode();
  const challenge = randomBytes(32).toString("base64");
  const ttlMin = env.xiaozhi.activationTtlMin;
  const expiresAt = new Date(Date.now() + ttlMin * 60_000);

  // ESP32 reads this string and shows it on the display + reads it aloud via
  // ShowActivationCode (digits spoken one-by-one). Keep it actionable: tell the
  // operator exactly what code to enter and where to enter it.
  const consoleUrl = env.xiaozhi.otaBaseUrl.replace(/\/+$/, "");
  const message =
    `请在 Andy Studio 后台「激活码」页面输入设备码 ${code} 绑定设备,` +
    `或打开 ${consoleUrl}/devices 完成激活。`;

  const created = await db.activation.create({
    data: {
      code,
      deviceId: devicePk,
      status: "pending",
      challenge,
      message,
      expiresAt,
    },
  });

  return {
    code: created.code,
    message: created.message ?? "",
    challenge: created.challenge,
    timeout_ms: ttlMin * 60_000,
  };
}

function normalizeBoard(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (lower === "unknown" || lower === "esp32" || lower === "esp32s3") return "esp32s3";
  return raw;
}

function normalizeVariant(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (lower === "xiaozhi" || lower === "default" || lower === "unknown") return "default";
  return raw;
}

export async function handleOtaRequest(info: DeviceSystemInfo): Promise<OtaResponse> {
  const deviceId = info.mac_address;
  const clientId = info.uuid;

  let device = await db.device.findFirst({
    where: { OR: [{ deviceId }, { clientId }] },
  });

  const variantName = normalizeVariant(info.application?.name);
  const boardName = normalizeBoard(info.chip_model_name);

  if (!device) {
    device = await db.device.create({
      data: {
        deviceId,
        clientId,
        board: boardName ?? "unknown",
        variant: variantName ?? "default",
        boardName: null,
        serialNumber: null,
        appVersion: info.application?.version ?? null,
        status: "pending_activation",
        metadata: info as unknown as object,
      },
    });
  } else {
    await db.device.update({
      where: { id: device.id },
      data: {
        deviceId,
        clientId,
        board: boardName ?? device.board,
        variant: variantName ?? device.variant,
        appVersion: info.application?.version ?? device.appVersion,
        lastSeenAt: new Date(),
        metadata: info as unknown as object,
        deletedAt: null,
      },
    });
  }

  try {
    await ensureWorkspace(clientId);
  } catch (err) {
    console.error("[OTA] ensureWorkspace failed:", err);
  }

  const token = await issueDeviceToken({
    devicePk: device.id,
    clientId,
    deviceId,
  });

  const mqtt = {
    endpoint: env.xiaozhi.mqttBrokerHost
      ? `${env.xiaozhi.mqttBrokerHost}:${env.xiaozhi.mqttPort}`
      : `${env.mqtt.broker || "localhost"}:${env.xiaozhi.mqttPort}`,
    client_id: clientId,
    username: "root",
    password: "Yzr12345678",
    keepalive: 240,
    publish_topic: `device/${clientId}/messages`,
  };

  const websocket = {
    url: env.xiaozhi.wsUrl || `wss://${new URL(env.xiaozhi.otaBaseUrl).host}/api/v1/internal/ws`,
    token,
    version: 1 as const,
  };

  const firmware = await pickFirmwareForDevice({
    board: boardName ?? "unknown",
    variant: variantName ?? "default",
    clientId,
  });

  let activation: OtaResponse["activation"] | undefined;
  if (device.status === "pending_activation") {
    activation = await buildActivation(device.id);
  }

  await writeAudit({
    actor: "device",
    actorId: clientId,
    action: "ota.request",
    target: `device:${deviceId}`,
    payload: {
      appVersion: info.application?.version,
      board: boardName,
      hasActivation: !!activation,
      hasFirmware: !!firmware,
    },
  });

  return {
    ...(firmware ? { firmware } : {}),
    mqtt,
    websocket,
    server_time: { timestamp: Date.now(), timezone_offset: -(new Date().getTimezoneOffset()) },
    ...(activation ? { activation } : {}),
  };
}
