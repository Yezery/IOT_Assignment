/**
 * RAG skill — exposes device-specific knowledge retrieval as a tool
 * that the deepagent can call when it needs to ground an answer in the
 * device's private knowledge base.
 *
 * Each registered skill is scoped to ONE deviceId. Registering for
 * many devices inflates the system prompt quickly, so prefer registering
 * per-request (right before `callAgent`) rather than once at boot.
 */

import { z } from "zod";
import { tool } from "@langchain/core/tools";
import type { StructuredTool } from "@langchain/core/tools";

import { search, formatForPrompt, type RetrievedChunk } from "@/services/rag/retrieve";

/**
 * Build a retrieval tool scoped to a single device.
 *
 * Tool name: `retrieve_device_<id>_knowledge`
 * Input: { query: string, topK?: number }
 * Output: a text block with the top-K chunks, or a not-found message.
 *
 * The agent decides when to call this — it does NOT auto-inject on
 * every request (saves tokens for trivial questions).
 */
export function buildDeviceRetrievalTool(deviceId: string): StructuredTool {
  const toolName = `retrieve_device_${sanitize(deviceId)}_knowledge`;

  return tool(
    async ({ query, topK }: { query: string; topK?: number }) => {
      try {
        const chunks: RetrievedChunk[] = await search(deviceId, query, { topK });
        if (chunks.length === 0) {
          return (
            `No relevant knowledge found in the device "${deviceId}" knowledge base. ` +
            `Answer based on general knowledge only and note that the device-specific KB had no match.`
          );
        }
        return (
          `Retrieved ${chunks.length} chunk(s) from device "${deviceId}":\n\n` +
          formatForPrompt(chunks)
        );
      } catch (err) {
        return `[RAG error] ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: toolName,
      description:
        `Retrieves relevant knowledge from the private knowledge base ` +
        `for device "${deviceId}". Call this whenever the user asks about ` +
        `device configuration, troubleshooting, capabilities, or any topic ` +
        `that might be documented for this specific device. ` +
        `Returns the top matching text chunks with similarity scores; cite ` +
        `the chunk id (e.g. "<doc>#<index>") when using the information.`,
      schema: z.object({
        query: z.string().min(1).describe("Natural-language search query"),
        topK: z.number().int().min(1).max(10).optional(),
      }),
    },
  );
}

/** Tool names must be `[A-Za-z0-9_-]+` per JSON-RPC convention. */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Build a system-prompt snippet that tells the agent the RAG tool exists.
 *
 * Pair with `buildDeviceRetrievalTool(deviceId)` and pass both into
 * `createDeepAgent({ tools: [tool] })`.
 */
export function buildRagSystemHint(deviceId: string): string {
  return (
    `\n\n## Device knowledge base\n` +
    `You have access to a private knowledge base for device "${deviceId}". ` +
    `When the user asks anything that might be answered from this base, ` +
    `call the retrieve_device_${sanitize(deviceId)}_knowledge tool with a focused ` +
    `query, then cite the chunk id when you use the retrieved information. ` +
    `Do not invent knowledge — if retrieval returns nothing, say so.`
  );
}