/**
 * Embeddings client — Ollama /api/embeddings.
 *
 * Uses raw `fetch` against a local Ollama instance. We don't depend on
 * `@langchain/ollama` because the only surface we need is `embedDocuments`
 * and `embedQuery`, both of which are trivially implemented against the
 * Ollama HTTP endpoint.
 *
 * Model is configured at runtime; default matches the embedding model
 * we already have running locally:
 *   - `qwen3-embedding:8b`     (4096-dim, multilingual)
 *   - `nomic-embed-text`       (768-dim, English only) — faster, smaller
 *   - `bge-m3`                 (1024-dim, multilingual)
 *
 * Override via `EMBEDDING_MODEL` env.
 */

import { env } from "@/lib/env";

const DEFAULT_MODEL = process.env.EMBEDDING_MODEL ?? "qwen3-embedding:8b";
const BASE_URL = (env.llm.baseUrl ?? "http://localhost:11434").replace(
  /\/v1\/?$/,
  "",
);
const TIMEOUT_MS = Number.parseInt(
  process.env.EMBEDDING_TIMEOUT_MS ?? "30000",
  10,
);

interface OllamaEmbeddingResponse {
  embedding: number[];
}

export interface EmbeddingClient {
  readonly model: string;
  readonly dim: number;
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
  probeDim(): Promise<number>;
}

/**
 * Call Ollama /api/embeddings. Throws on timeout / HTTP failure.
 *
 * NOTE: Ollama's `prompt` field accepts a single string per request, and
 * the response is `{embedding: number[]}` (singular). To embed multiple
 * texts we issue parallel requests.
 */
async function ollamaEmbed(text: string): Promise<number[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: DEFAULT_MODEL, prompt: text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`[Embeddings] Ollama ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as OllamaEmbeddingResponse;
    if (!data.embedding || data.embedding.length === 0) {
      throw new Error("[Embeddings] empty response from Ollama");
    }
    return data.embedding;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Singleton embedding client. Cached on `globalThis` so HMR / multiple
 * route handlers share one probe call.
 */
declare global {
  var __andyEmbedClient: EmbeddingClient | undefined;
}

export function getEmbeddings(): EmbeddingClient {
  if (!globalThis.__andyEmbedClient) {
    let cachedDim: number | undefined;
    const client: EmbeddingClient = {
      model: DEFAULT_MODEL,
      get dim() {
        return cachedDim ?? 0;
        // Will be replaced after probeDim().
      },
      async embedQuery(text) {
        return ollamaEmbed(text);
      },
      async embedDocuments(texts) {
        if (texts.length === 0) return [];
        const results = await Promise.all(texts.map(ollamaEmbed));
        return results;
      },
      async probeDim() {
        const vec = await ollamaEmbed("dimension probe");
        cachedDim = vec.length;
        // Override getter to expose the resolved value.
        Object.defineProperty(client, "dim", {
          value: cachedDim,
          configurable: true,
        });
        return cachedDim;
      },
    };
    globalThis.__andyEmbedClient = client;
  }
  return globalThis.__andyEmbedClient;
}