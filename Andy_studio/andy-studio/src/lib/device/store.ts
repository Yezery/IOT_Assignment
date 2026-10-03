/**
 * In-memory device state store.
 *
 * First version per spec uses a plain `Map`. To migrate to Postgres later,
 * swap the internals of these functions with a DB client — the API shape is
 * deliberately the same shape a future repository would expose.
 *
 * Singleton via `globalThis` so HMR doesn't drop the in-memory map
 * every time the dev server reloads a module.
 */

import type { DeviceStatus } from "@/types/device";

type DeviceListener = (device: DeviceStatus) => void;

const STALE_AFTER_MS = 90_000;

function effectiveStatus(device: DeviceStatus): DeviceStatus {
  if (device.status === "online" && Date.now() - device.lastSeen > STALE_AFTER_MS) {
    return { ...device, status: "offline" };
  }
  return device;
}

interface DeviceStoreShape {
  devices: Map<string, DeviceStatus>;
  listeners: Set<DeviceListener>;
}

declare global {
  var __andyDeviceStore: DeviceStoreShape | undefined;
}

function getStore(): DeviceStoreShape {
  if (!globalThis.__andyDeviceStore) {
    globalThis.__andyDeviceStore = {
      devices: new Map<string, DeviceStatus>(),
      listeners: new Set<DeviceListener>(),
    };
  }
  return globalThis.__andyDeviceStore;
}

/** Insert or update a device record (full upsert). */
export function upsertDevice(status: DeviceStatus): void {
  const store = getStore();
  const existing = store.devices.get(status.deviceId);

  // Preserve the most recent `lastSeen` only when the new value is later —
  // protects against slightly out-of-order retained message delivery.
  const merged: DeviceStatus = existing
    ? {
        ...existing,
        ...status,
        lastSeen: Math.max(existing.lastSeen, status.lastSeen),
      }
    : status;

  store.devices.set(status.deviceId, merged);

  // Fan-out for future WebSocket / SSE integrations.
  for (const listener of store.listeners) {
    try {
      listener(merged);
    } catch (err) {
      console.error("[DeviceStore] listener threw:", err);
    }
  }
}

/** Return every known device. Result is a fresh array — safe to mutate. */
export function listDevices(): DeviceStatus[] {
  return Array.from(getStore().devices.values()).map(effectiveStatus);
}

/** Test-only: insert a device without going through MQTT. */
export function __seedDeviceForTest(d: DeviceStatus): void {
  getStore().devices.set(d.deviceId, d);
}

/** Look up a single device by id; returns `null` if unknown. */
export function getDevice(deviceId: string): DeviceStatus | null {
  const device = getStore().devices.get(deviceId);
  return device ? effectiveStatus(device) : null;
}

/**
 * Compute aggregate counters for the dashboard header.
 *
 * Kept here (rather than in the UI) so both REST and any future push
 * channel can share the same logic.
 */
export function getDeviceCounts(): {
  total: number;
  online: number;
  offline: number;
} {
  const all = listDevices();
  let online = 0;
  for (const d of all) {
    if (d.status === "online") online += 1;
  }
  return {
    total: all.length,
    online,
    offline: all.length - online,
  };
}

/**
 * Subscribe to device updates. Returns an unsubscribe function.
 *
 * NOT used by the v1 polling UI, but exposed so future WebSocket / SSE
 * code can plug in without touching the store internals.
 */
export function subscribeDeviceUpdates(listener: DeviceListener): () => void {
  const store = getStore();
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

/** Test-only: wipe the store. Not exported from the public API surface. */
export function __resetDeviceStoreForTests(): void {
  const store = getStore();
  store.devices.clear();
  store.listeners.clear();
}
