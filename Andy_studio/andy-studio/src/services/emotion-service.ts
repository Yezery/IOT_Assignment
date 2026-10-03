/**
 * Emotion classification — feeds the AI engine.
 *
 * Detects the emotional tone of each user prompt and passes the label
 * into `CallOpts.emotion`. The engine then injects a tone-matching
 * paragraph into the system prompt (see `prompts.buildEmotionHint`).
 *
 * Provider is selected at runtime based on env:
 *   - `EMOTION_API_KEY` set  → `HttpEmotionProvider`
 *   - otherwise              → `MockEmotionProvider` (returns "neutral")
 *
 * Real provider integration: POST {text} → expect {label, confidence}.
 * For HuggingFace models, point `EMOTION_API_URL` at any HF Inference
 * Endpoint or a small FastAPI wrapper. The response shape is normalized
 * here so callers only ever see one canonical label set.
 */

export type EmotionLabel =
  | "neutral"
  | "happy"
  | "sad"
  | "angry"
  | "anxious"
  | "curious"
  | "tired"
  | "unknown";

export interface EmotionResult {
  label: EmotionLabel;
  confidence: number;
}

export interface EmotionProvider {
  readonly name: string;
  detect(text: string): Promise<EmotionResult>;
}

const VALID: ReadonlySet<EmotionLabel> = new Set<EmotionLabel>([
  "neutral",
  "happy",
  "sad",
  "angry",
  "anxious",
  "curious",
  "tired",
  "unknown",
]);

class MockEmotionProvider implements EmotionProvider {
  public readonly name = "mock";

  public async detect(): Promise<EmotionResult> {
    return { label: "neutral", confidence: 0.5 };
  }
}

class HttpEmotionProvider implements EmotionProvider {
  public readonly name: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  public constructor(url: string, apiKey: string, timeoutMs: number) {
    this.url = url;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    try {
      this.name = `http(${new URL(url).host})`;
    } catch {
      this.name = "http(invalid-url)";
    }
  }

  public async detect(text: string): Promise<EmotionResult> {
    const controller = new AbortController();
    const timer =
      this.timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : null;
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!res.ok) return { label: "unknown", confidence: 0 };
      const data = (await res.json().catch(() => ({}))) as {
        label?: string;
        confidence?: number;
      };
      const label: EmotionLabel = VALID.has(data.label as EmotionLabel)
        ? (data.label as EmotionLabel)
        : "unknown";
      const confidence =
        typeof data.confidence === "number"
          ? Math.max(0, Math.min(1, data.confidence))
          : 0.5;
      return { label, confidence };
    } catch {
      return { label: "unknown", confidence: 0 };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

declare global {
  var __andyEmotionProvider: EmotionProvider | undefined;
}

function pickProvider(): EmotionProvider {
  const apiKey = process.env.EMOTION_API_KEY ?? "";
  const url = process.env.EMOTION_API_URL ?? "";
  const timeoutMs = Number.parseInt(
    process.env.EMOTION_TIMEOUT_MS ?? "5000",
    10,
  );
  if (apiKey.trim().length > 0 && url.trim().length > 0) {
    return new HttpEmotionProvider(url, apiKey, timeoutMs);
  }
  return new MockEmotionProvider();
}

export function getEmotionProvider(): EmotionProvider {
  if (!globalThis.__andyEmotionProvider) {
    globalThis.__andyEmotionProvider = pickProvider();
    console.log(`[Emotion] Active provider: ${globalThis.__andyEmotionProvider.name}`);
  }
  return globalThis.__andyEmotionProvider;
}

/**
 * Always returns a label. Never throws — the chat pipeline must keep
 * running even when the emotion classifier is misconfigured or down.
 */
export async function detectEmotion(text: string): Promise<EmotionResult> {
  try {
    return await getEmotionProvider().detect(text);
  } catch (err) {
    console.error("[Emotion] provider failed:", err);
    return { label: "unknown", confidence: 0 };
  }
}