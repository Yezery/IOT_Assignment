/**
 * Chat service.
 *
 * Thin glue between transport (HTTP route / MQTT handler) and the AI
 * engine. Responsibilities:
 *   1. Run emotion detection on the prompt (parallel-safe; never throws).
 *   2. If `deviceId` provided, attach the device's RAG retrieval tool
 *      to the agent (lazy — only if the KB has documents) AND load the
 *      per-device SOUL override (if any).
 *   3. Hand the prompt + emotion + per-device prompt + optional RAG tool
 *      to `callAgent()`.
 *   4. Translate LLM failures into the `ChatHandleResult` shape used
 *      by both transports.
 *
 * Everything else — system prompt composition, MCP, skills, streaming —
 * lives inside `@/services/ai`. This file stays small on purpose.
 */

import type { ChatRequestPayload, ChatResponsePayload } from "@/types/chat";
import { callAgent } from "@/services/ai";
import { detectEmotion } from "@/services/emotion-service";
import { env } from "@/lib/env";
import { buildDeviceRetrievalTool, buildRagSystemHint } from "@/services/rag/skill";
import { buildWikiRetrievalTool, buildWikiSystemHint, buildPatientDossier } from "@/services/workspace";
import { buildChatHistoryTool, buildChatHistorySystemHint } from "@/services/tools/chat-history-tool";
import { appendMessage, getHistoryForPrompt } from "@/services/chat-history";
import { getDeviceSystemPrompt } from "@/services/ai/device-prompt-store";
import type { StructuredTool } from "@langchain/core/tools";

const FALLBACK_REPLY = "抱歉，AI 服务暂时不可用。";

export type ChatHandleResult =
  | { kind: "ok"; reply: ChatResponsePayload; durationMs: number; emotion: string }
  | { kind: "fallback"; reply: ChatResponsePayload; durationMs: number; reason: string }
  | { kind: "error"; reason: string };

export interface AgentOpts {
  emotion: string;
  systemHint?: string;
  devicePrompt?: string;
  extraTools: StructuredTool[];
  history: { role: "user" | "assistant"; content: string }[];
  scope?: string;
}

/**
 * Build the CallOpts needed by `callAgent` / `callAgentWithToolsStreaming`
 * for a given prompt + optional device id. The streaming reply pipeline
 * uses this so the two paths stay in lockstep on which tools / history /
 * device prompt / scope are wired in.
 */
export async function buildAgentOpts(
  prompt: string,
  deviceId?: string,
): Promise<AgentOpts> {
  // Emotion classification must never sit on the critical first-token path.
  // Keep the result when it is immediately available (mock/local), otherwise
  // proceed with neutral tone after a short deadline.
  const emotionTask = detectEmotion(prompt).catch((err) => {
    console.error("[Chat] emotion detection failed:", err);
    return { label: "neutral" as const, confidence: 0 };
  });
  const emotionDeadlineMs = Math.max(0, Number(process.env.EMOTION_BUDGET_MS ?? "120"));
  const emotion = await Promise.race([
    emotionTask,
    new Promise<{ label: "neutral"; confidence: number }>((resolve) =>
      setTimeout(() => resolve({ label: "neutral", confidence: 0 }), emotionDeadlineMs),
    ),
  ]);
  const emotionLabel = emotion.label;

  const extraTools: StructuredTool[] = [];
  let systemHint: string | undefined;
  let devicePrompt: string | undefined;
  let history: { role: "user" | "assistant"; content: string }[] = [];

  if (deviceId) {
    try {
      if (env.knowledge.type === "rag") {
        extraTools.push(buildDeviceRetrievalTool(deviceId));
        systemHint = buildRagSystemHint(deviceId);
      } else {
        extraTools.push(buildWikiRetrievalTool(deviceId));
        systemHint = buildWikiSystemHint(deviceId);
        // Full dossiers add filesystem I/O and thousands of prompt characters
        // on every turn. Retrieval is already available; only opt in to eager
        // dossier injection for deployments that explicitly require it.
        if (process.env.AI_EAGER_PATIENT_DOSSIER === "true") {
          const dossier = await buildPatientDossier(deviceId);
          if (dossier) {
            systemHint += `\n\n## 病人资料（权威，只读，回答病人相关问题前先读）\n${dossier}`;
          }
        }
      }
      extraTools.push(buildChatHistoryTool(deviceId));
      systemHint = (systemHint ?? "") + buildChatHistorySystemHint(deviceId);
      devicePrompt = getDeviceSystemPrompt(deviceId);
      history = await getHistoryForPrompt(deviceId);
    } catch (err) {
      console.error(`[Chat] failed to build device context for ${deviceId}:`, err);
    }
  }

  return {
    emotion: emotionLabel,
    systemHint,
    devicePrompt,
    extraTools,
    history,
    ...(deviceId ? { scope: deviceId } : {}),
  };
}

export interface ChatService {
  handle(request: ChatRequestPayload, deviceId?: string): Promise<ChatHandleResult>;
}

export const chatService: ChatService = {
  async handle(request, deviceId) {
    const startedAt = Date.now();

    const opts = await buildAgentOpts(request.prompt, deviceId);

    try {
      const reply = await callAgent(request.prompt, opts);
      if (deviceId) {
        try {
          await appendMessage(deviceId, "user", request.prompt);
          await appendMessage(deviceId, "assistant", reply);
        } catch (err) {
          console.error(`[Chat] failed to persist history for ${deviceId}:`, err);
        }
      }
      const durationMs = Date.now() - startedAt;
      console.log(
        `[Chat] agent finished in ${durationMs}ms (emotion=${opts.emotion}${deviceId ? `, kb=${env.knowledge.type}` : ""}${opts.devicePrompt ? ", customSoul" : ""})`,
      );
      return {
        kind: "ok",
        reply: { reply },
        durationMs,
        emotion: opts.emotion,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[Chat] agent failed after ${durationMs}ms:`, reason);
      return { kind: "error", reason };
    }
  },
};

export function buildFallbackReply(): ChatResponsePayload {
  return { reply: FALLBACK_REPLY };
}