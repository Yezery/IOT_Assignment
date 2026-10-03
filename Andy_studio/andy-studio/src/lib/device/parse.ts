/**
 * Pure parsing functions for incoming MQTT status payloads.
 *
 * Kept side-effect-free so they are trivial to unit-test and can be reused
 * by future message types (event, emotion, etc.).
 */

import type {
  DeviceConnectionStatus,
  DeviceStatus,
  ParsedDeviceMessage,
  RawDeviceStatusPayload,
} from "@/types/device";

const VALID_STATUSES: ReadonlySet<DeviceConnectionStatus> = new Set([
  "online",
  "offline",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate and normalize a raw MQTT payload from `device/{id}/status`.
 *
 * Returns a discriminated union so callers can log warnings without
 * needing to throw exceptions.
 */
export function parseDeviceStatusMessage(
  raw: unknown,
  fallbackDeviceId?: string,
): ParsedDeviceMessage {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, reason: "payload is not an object" };
  }

  const payload = raw as RawDeviceStatusPayload;

  // device_id is mandatory; fall back to the topic's wildcard capture if the
  // device forgot to include it (defensive, not in spec).
  const deviceId = isNonEmptyString(payload.device_id)
    ? payload.device_id
    : fallbackDeviceId;

  if (!isNonEmptyString(deviceId)) {
    return { ok: false, reason: "missing device_id" };
  }

  if (!isNonEmptyString(payload.status)) {
    return { ok: false, reason: "missing status" };
  }

  if (!VALID_STATUSES.has(payload.status as DeviceConnectionStatus)) {
    return {
      ok: false,
      reason: `unknown status "${payload.status as string}"`,
    };
  }

  const status: DeviceStatus = {
    deviceId,
    status: payload.status as DeviceConnectionStatus,
    lastSeen: Date.now(),
  };

  // `ip` is optional; only attach when present and well-typed.
  if (isNonEmptyString(payload.ip)) {
    status.ip = payload.ip;
  }

  return { ok: true, status };
}

/**
 * Parse a `device/{id}/status` topic and return the device id segment.
 *
 * Returns `null` for topics that don't match the expected pattern.
 */
export function extractDeviceIdFromStatusTopic(topic: string): string | null {
  // We don't use a regex lib — this single pattern is plenty for the spec.
  const parts = topic.split("/");
  if (parts.length !== 3) return null;
  if (parts[0] !== "device" || parts[2] !== "status") return null;
  return parts[1] || null;
}
