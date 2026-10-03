/**
 * Chat-history tool — exposes a device's OWN persisted conversation as a
 * read-only tool. Scoped to one deviceId via closure so the agent can never
 * query another device's history.
 *
 * Mirrors the shape of `src/services/rag/skill.ts`.
 */

import { z } from "zod";
import { tool } from "@langchain/core/tools";
import type { StructuredTool } from "@langchain/core/tools";

import {
  getDayMessages,
  getHistoryForPrompt,
  type HistoryRow,
} from "@/services/chat-history";
import { formatShanghaiDateTime } from "@/lib/time";

export function buildChatHistoryTool(deviceId: string): StructuredTool {
  return tool(
    async ({ day, limit }: { day?: string; limit?: number }) => {
      try {
        if (day) {
          const rows = await getDayMessages(deviceId, day);
          if (rows.length === 0) {
            return `No chat history found for device "${deviceId}" on ${day}.`;
          }
          return `Chat history for device "${deviceId}" on ${day}:\n\n${formatRows(rows)}`;
        }

        const messages = await getHistoryForPrompt(deviceId, limit);
        if (messages.length === 0) {
          return (
            `No chat history found for device "${deviceId}" today. ` +
            `This is a fresh conversation — there is no earlier context to recall.`
          );
        }
        return `Recent chat history for device "${deviceId}" (today):\n\n${messages
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n")}`;
      } catch (err) {
        return `[chat-history error] ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: "query_chat_history",
      description:
        `Reads this device's own persisted chat history. Call this when the ` +
        `user refers to earlier conversation, asks what was discussed, or ` +
        `needs context from a previous exchange. History is private to this ` +
        `device and resets at midnight Asia/Shanghai. Optionally pass a ` +
        `"day" (YYYY-MM-DD) to read a specific day, or a "limit" to cap how ` +
        `many recent messages are returned. This tool is read-only.`,
      schema: z.object({
        day: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Day to read in YYYY-MM-DD (Asia/Shanghai). Defaults to today."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe("Max recent messages to return (1-50). Defaults to 20."),
      }),
    },
  );
}

function formatRows(rows: HistoryRow[]): string {
  return rows
    .map(
      (row) =>
        `[${formatShanghaiDateTime(row.createdAt).slice(0, 16)}] ${row.role}: ${row.content}`,
    )
    .join("\n");
}

export function buildChatHistorySystemHint(deviceId: string): string {
  return (
    `\n\n## 对话历史\n` +
    `设备 "${deviceId}" 的历史对话已持久化保存（按天存储，时区 Asia/Shanghai）。` +
    `当用户提到之前聊过的内容、追问上文，或需要历史上下文时，调用 query_chat_history 工具查询。` +
    `该工具只能读取本设备自己的私有历史，支持传入 day（YYYY-MM-DD）查询指定日期，` +
    `或 limit 限制返回条数；它只读，不会修改任何数据。` +
    `历史在每天 Asia/Shanghai 午夜自动"重置"——新的一天没有前一天的上下文。`
  );
}
