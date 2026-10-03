import { db } from "@/storage/db";
import type { DeviceStatus } from "@/types/device";

export const ONLINE_WINDOW_MS = 90_000;

export async function findDeviceRow(deviceId: string) {
  return db.device.findFirst({
    where: { OR: [{ clientId: deviceId }, { deviceId }] },
  });
}

export function toDeviceStatus(row: {
  clientId: string;
  deviceId: string;
  board: string;
  variant: string;
  boardName: string | null;
  appVersion: string | null;
  serialNumber: string | null;
  alias: string | null;
  lastSeenAt: Date | null;
}): DeviceStatus {
  const seen = row.lastSeenAt?.getTime() ?? 0;
  return {
    deviceId: row.clientId,
    mac: row.deviceId,
    status: seen > 0 && Date.now() - seen < ONLINE_WINDOW_MS ? "online" : "offline",
    lastSeen: seen,
    displayName: row.alias ?? undefined,
    board: row.board,
    variant: row.variant,
    boardName: row.boardName ?? undefined,
    appVersion: row.appVersion ?? undefined,
    serialNumber: row.serialNumber ?? undefined,
  };
}
