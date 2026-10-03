import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LABELS = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "anxious",
  "curious",
  "tired",
] as const;
type Label = (typeof LABELS)[number];

const KEYWORDS: Array<[Label, RegExp]> = [
  ["happy", /开心|高兴|快乐|太好了|棒|赞|哈哈|嘿嘿|嘻嘻|喜欢|爱你|爽|happy|great|awesome|lol/i],
  ["sad", /难过|伤心|哭|委屈|失落|沮丧|痛苦|郁闷|sad|unhappy|depressed/i],
  ["angry", /生气|气愤|愤怒|讨厌|烦|气死|无语|垃圾|angry|mad|annoyed|hate/i],
  ["anxious", /焦虑|担心|害怕|紧张|恐慌|不安|糟糕|怎么办|anxious|worried|scared|nervous/i],
  ["tired", /累|困|疲惫|疲乏|没力气|tired|exhausted|sleepy/i],
  ["curious", /为什么|怎么|如何|是什么|什么意思|请问|想知道|吗？|吗\?|why|how|what/i],
];

const SYSTEM_PROMPT =
  '你是情绪分类器。只输出 JSON：{"label":"neutral|happy|sad|angry|anxious|curious|tired","confidence":0到1}。不要解释。';

function ruleBased(text: string): { label: Label; confidence: number } {
  for (const [label, re] of KEYWORDS) {
    if (re.test(text)) return { label, confidence: 0.7 };
  }
  return { label: "neutral", confidence: 0.5 };
}

function parseLabel(content: string): { label: Label; confidence: number } | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { label?: string; confidence?: number };
    const label = LABELS.find((l) => l === parsed.label);
    if (!label) return null;
    const confidence =
      typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.6;
    return { label, confidence };
  } catch {
    return null;
  }
}

async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function llmBased(
  text: string,
): Promise<{ label: Label; confidence: number } | null> {
  const base = process.env.LLM_BASE_URL ?? "";
  if (!base) return null;
  const model = (process.env.LLM_MODEL ?? "").replace(/^openai:/, "");
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: text },
  ];

  const native = await postJson<{ message?: { content?: string } }>(
    `${base}/api/chat`,
    { model, think: false, stream: false, options: { num_predict: 40, temperature: 0 }, messages },
    {},
    4000,
  );
  if (native?.message?.content) {
    const parsed = parseLabel(native.message.content);
    if (parsed) return parsed;
  }

  const apiKey = process.env.LLM_API_KEY ?? "";
  const openai = await postJson<{ choices?: Array<{ message?: { content?: string } }> }>(
    `${base}/v1/chat/completions`,
    { model, temperature: 0, max_tokens: 40, messages },
    apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    4000,
  );
  const openaiContent = openai?.choices?.[0]?.message?.content;
  if (openaiContent) {
    const parsed = parseLabel(openaiContent);
    if (parsed) return parsed;
  }
  return null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let text = "";
  try {
    const body = (await req.json()) as { text?: unknown };
    text = typeof body.text === "string" ? body.text : "";
  } catch {
    return NextResponse.json({ label: "unknown", confidence: 0 });
  }
  if (!text.trim()) {
    return NextResponse.json({ label: "neutral", confidence: 0.5 });
  }

  const fromLlm = await llmBased(text);
  if (fromLlm) return NextResponse.json(fromLlm);
  return NextResponse.json(ruleBased(text));
}
