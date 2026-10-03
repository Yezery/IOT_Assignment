/**
 * Thin service facade over the device store.
 *
 * Routes call into this layer (not the store directly) so that swapping
 * the in-memory `Map` for Postgres later doesn't require touching any
 * route handler.
 */

import type { DeviceStatus } from "@/types/device";
import {
  getDevice,
  getDeviceCounts,
  listDevices,
  upsertDevice,
} from "@/lib/device/store";
import { getAlias } from "@/lib/device/alias-store";

function withDisplayName(d: DeviceStatus): DeviceStatus {
  const alias = getAlias(d.deviceId);
  return alias ? { ...d, displayName: alias } : d;
}

export const deviceService = {
  list(): DeviceStatus[] {
    return listDevices().map(withDisplayName);
  },

  get(deviceId: string): DeviceStatus | null {
    const d = getDevice(deviceId);
    return d ? withDisplayName(d) : null;
  },

  upsert(status: DeviceStatus): void {
    upsertDevice(status);
  },

  counts(): { total: number; online: number; offline: number } {
    return getDeviceCounts();
  },
} as const;

export type DeviceService = typeof deviceService;
