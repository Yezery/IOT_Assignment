/**
 * Domain types shared across MQTT layer, device store, API routes and UI.
 *
 * Keep this file PURE types (no runtime code) so it can be imported from
 * both server and client without pulling in node-only modules.
 */

/** A device can only be online or offline (per spec). */
export type DeviceConnectionStatus = "online" | "offline";

/**
 * The internal, normalized representation of a device's runtime state.
 *
 * Field naming uses `camelCase` regardless of the on-wire MQTT payload
 * (which is `snake_case`). Conversion happens in the MQTT handler.
 */
export interface DeviceStatus {
  /** Stable device identifier used in URLs / RAG keys (the MQTT clientId). */
  deviceId: string;
  /** Hardware MAC address (DB `device_id`). */
  mac?: string;
  status: DeviceConnectionStatus;
  /** IP address reported by the device on connect. Optional. */
  ip?: string;
  /** Unix epoch (ms) of the last update we received from / about the device. */
  lastSeen: number;
  /**
   * Human-friendly display name set by the operator via the dashboard.
   * Undefined when the device has no alias yet — UI falls back to
   * showing `deviceId` in that case.
   */
  displayName?: string;
  board?: string;
  variant?: string;
  boardName?: string;
  appVersion?: string;
  serialNumber?: string;
}

/**
 * The raw MQTT payload shape published by the ESP32 on `device/{id}/status`.
 *
 * ESP32 firmware publishes `snake_case` JSON; we keep this type strict so we
 * fail loudly if the firmware changes shape.
 */
export interface RawDeviceStatusPayload {
  device_id?: unknown;
  status?: unknown;
  ip?: unknown;
}

/**
 * Result of validating a raw MQTT payload. Either we accept it and yield
 * a normalized status, or we discard it with a reason for logging.
 */
export type ParsedDeviceMessage =
  | { ok: true; status: DeviceStatus }
  | { ok: false; reason: string };
