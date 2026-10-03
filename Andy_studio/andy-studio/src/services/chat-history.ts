/**
 * Server-only persistence for device-bound, per-day chat history.
 *
 * History is keyed by `deviceId` + Asia/Shanghai `day` ("YYYY-MM-DD").
 * A new day simply yields no prior rows — "reset next day" is a date
 * filter, not a deletion. All reads are scoped to a single device.
 */

import { db } from "@/storage/db";
import { shanghaiDay } from "@/lib/time";

export type HistoryRole = "user" | "assistant";

export interface HistoryRow {
  id: string;
  deviceId: string;
  day: string;
  role: HistoryRole;
  content: string;
  createdAt: Date;
}

const DEFAULT_PROMPT_LIMIT = Number.parseInt(process.env.CHAT_HISTORY_LIMIT ?? "8", 10) || 8;
const MAX_MESSAGE_CHARS = Number.parseInt(process.env.CHAT_HISTORY_MAX_CHARS ?? "500", 10) || 500;
const DEFAULT_RECENT_DAYS = 7;

function assertDeviceId(deviceId: string): void {
  if (!deviceId || deviceId.trim() === "") {
    throw new Error("[chat-history] deviceId must be a non-empty string");
  }
}

export async function appendMessage(
  deviceId: string,
  role: HistoryRole,
  content: string,
): Promise<void> {
  assertDeviceId(deviceId);
  await db.chatMessage.create({
    data: {
      deviceId,
      day: shanghaiDay(),
      role,
      content,
    },
  });
}

export async function getDayMessages(
  deviceId: string,
  day?: string,
): Promise<HistoryRow[]> {
  assertDeviceId(deviceId);
  const rows = await db.chatMessage.findMany({
    where: { deviceId, day: day ?? shanghaiDay() },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toHistoryRow);
}

export async function getHistoryForPrompt(
  deviceId: string,
  limit: number = DEFAULT_PROMPT_LIMIT,
): Promise<{ role: HistoryRole; content: string }[]> {
  assertDeviceId(deviceId);
  const rows = await db.chatMessage.findMany({
    where: { deviceId, day: shanghaiDay() },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows
    .map((row) => ({
      role: row.role as HistoryRole,
      content: clampContent(row.content, MAX_MESSAGE_CHARS),
    }))
    .reverse();
}

function clampContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}…`;
}

export async function getRecentDays(
  deviceId: string,
  days: number = DEFAULT_RECENT_DAYS,
): Promise<{ day: string; count: number }[]> {
  assertDeviceId(deviceId);
  const grouped = await db.chatMessage.groupBy({
    by: ["day"],
    where: { deviceId },
    _count: { _all: true },
    orderBy: { day: "desc" },
    take: days,
  });
  return grouped.map((row) => ({ day: row.day, count: row._count._all }));
}

export async function clearDay(
  deviceId: string,
  day?: string,
): Promise<number> {
  assertDeviceId(deviceId);
  const result = await db.chatMessage.deleteMany({
    where: { deviceId, day: day ?? shanghaiDay() },
  });
  return result.count;
}

export async function clearHistory(
  deviceId: string,
  range: { day?: string; from?: string; to?: string } = {},
): Promise<number> {
  assertDeviceId(deviceId);
  const where = {
    deviceId,
    ...(range.day ? { day: range.day } : {}),
    ...(!range.day && (range.from || range.to)
      ? { day: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
      : {}),
  };
  const result = await db.chatMessage.deleteMany({ where });
  return result.count;
}

function toHistoryRow(row: {
  id: bigint;
  deviceId: string;
  day: string;
  role: string;
  content: string;
  createdAt: Date;
}): HistoryRow {
  return {
    id: String(row.id),
    deviceId: row.deviceId,
    day: row.day,
    role: row.role as HistoryRole,
    content: row.content,
    createdAt: row.createdAt,
  };
}
