/**
 * Device alias store — display names keyed by physical deviceId.
 *
 * Decoupled from `DeviceStatus` so a rename doesn't touch MQTT topics,
 * RAG DB files, or any other downstream system. The UI gets a friendly
 * label, the rest of the system keeps using the immutable deviceId.
 *
 * Lifecycle: in-memory Map, persisted nowhere. Renames survive HMR via
 * `globalThis`, and are wiped on full process restart. (Adding disk
 * persistence is one line — see comment below.)
 */

interface AliasStoreShape {
  byDeviceId: Map<string, string>;
}

declare global {
  var __andyDeviceAliases: AliasStoreShape | undefined;
}

function getStore(): AliasStoreShape {
  if (!globalThis.__andyDeviceAliases) {
    globalThis.__andyDeviceAliases = { byDeviceId: new Map() };
  }
  return globalThis.__andyDeviceAliases;
}

export function getAlias(deviceId: string): string | undefined {
  return getStore().byDeviceId.get(deviceId);
}

export function setAlias(deviceId: string, displayName: string): void {
  const trimmed = displayName.trim();
  if (trimmed.length === 0) {
    getStore().byDeviceId.delete(deviceId);
    return;
  }
  getStore().byDeviceId.set(deviceId, trimmed.slice(0, 64));
}

export function clearAlias(deviceId: string): boolean {
  return getStore().byDeviceId.delete(deviceId);
}

export function listAliases(): Record<string, string> {
  return Object.fromEntries(getStore().byDeviceId.entries());
}