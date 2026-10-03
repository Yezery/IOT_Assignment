/**
 * Chat request parsing.
 *
 * Lives next to the status parser so both message families share a single
 * validation surface.
 */

import type { ParsedChatRequest } from "@/types/chat";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Extract the device id segment from `device/{id}/chat/request`. */
export function extractDeviceIdFromChatRequestTopic(topic: string): string | null {
  const parts = topic.split("/");
  if (parts.length !== 4) return null;
  if (parts[0] !== "device" || parts[2] !== "chat" || parts[3] !== "request") {
    return null;
  }
  return parts[1] || null;
}

/** Validate a raw MQTT payload from `device/{id}/chat/request`. */
export function parseChatRequest(raw: unknown): ParsedChatRequest {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, reason: "Invalid chat request: payload is not an object" };
  }

  const obj = raw as { prompt?: unknown };

  if (!isNonEmptyString(obj.prompt)) {
    return { ok: false, reason: "Missing prompt" };
  }

  return {
    ok: true,
    request: { prompt: obj.prompt },
  };
}
