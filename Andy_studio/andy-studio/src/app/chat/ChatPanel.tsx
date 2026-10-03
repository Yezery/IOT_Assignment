"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DeviceConnectionStatus, DeviceStatus } from "@/types/device";

interface ChatSuccess {
  kind: "ok";
  reply: string;
  durationMs: number;
  provider: string;
  emotion?: string;
  degraded?: boolean;
  reason?: string;
}

interface ChatError {
  kind: "error";
  status: number;
  message: string;
  timeoutMs?: number;
}

type ChatOutcome = ChatSuccess | ChatError;

interface HistoryEntry {
  id: number;
  prompt: string;
  outcome: ChatOutcome;
  sentAt: number;
}

const REQUEST_TIMEOUT_MS = 180_000;
const DEVICE_POLL_MS = 5_000;
const KB_POLL_MS = 5_000;

export default function ChatPanel(): React.ReactElement {
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const [devices, setDevices] = useState<DeviceStatus[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");

  const [knowledgeType, setKnowledgeType] = useState<"rag" | "wiki">("wiki");
  const [kbCount, setKbCount] = useState<number | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const idRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/config", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { knowledgeType?: string };
        if (
          !cancelled &&
          (data.knowledgeType === "rag" || data.knowledgeType === "wiki")
        ) {
          setKnowledgeType(data.knowledgeType);
        }
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll the device list so the dropdown stays fresh.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load(): Promise<void> {
      try {
        const res = await fetch("/api/devices", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { devices: DeviceStatus[] };
        if (cancelled) return;
        setDevices(data.devices);
        setDeviceId((cur) => {
          if (cur && !data.devices.some((d) => d.deviceId === cur)) return "";
          return cur;
        });
      } catch {
        /* non-fatal — keep previous state */
      }
    }

    void load();
    const timer = setInterval(load, DEVICE_POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    // Reset to "loading" before re-querying. We route this through
    // queueMicrotask to satisfy react-hooks/set-state-in-effect.
    queueMicrotask(() => {
      if (!cancelled) setKbCount(null);
    });

    async function load(): Promise<void> {
      if (!deviceId) return;
      const url =
        knowledgeType === "wiki"
          ? `/api/workspace/${encodeURIComponent(deviceId)}`
          : `/api/rag/${encodeURIComponent(deviceId)}/docs`;
      try {
        const res = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) {
          if (!cancelled) setKbCount(null);
          return;
        }
        const data = (await res.json()) as {
          docs?: unknown[];
          files?: { raw?: unknown[]; wiki?: unknown[] };
        };
        if (cancelled) return;
        if (knowledgeType === "wiki") {
          const raw = data.files?.raw?.length ?? 0;
          const wiki = data.files?.wiki?.length ?? 0;
          setKbCount(raw + wiki);
        } else {
          setKbCount(data.docs?.length ?? 0);
        }
      } catch {
        if (!cancelled) setKbCount(null);
      }
    }

    void load();
    const timer = setInterval(load, KB_POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [deviceId, knowledgeType]);

  const submit = useCallback(async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || pending) return;

    const id = ++idRef.current;
    setPending(true);
    setPrompt("");

    try {
      const outcome = await postChat(trimmedPrompt, deviceId || undefined);
      setHistory((prev) => [
        { id, prompt: trimmedPrompt, outcome, sentAt: Date.now() },
        ...prev,
      ].slice(0, 20));
    } finally {
      setPending(false);
      inputRef.current?.focus();
    }
  }, [prompt, pending, deviceId]);

  return (
    <section className="space-y-6">
      <DeviceToolbar
        devices={devices}
        deviceId={deviceId}
        onChange={setDeviceId}
        knowledgeType={knowledgeType}
        kbCount={kbCount}
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
      >
        <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-slate-500">
          Prompt
        </label>
        <textarea
          ref={inputRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={
            deviceId
              ? 'Ask anything about the device KB · ⌘/Ctrl + Enter to send'
              : 'e.g. "你好"  ·  ⌘/Ctrl + Enter to send'
          }
          disabled={pending}
          rows={3}
          className="w-full resize-none rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm focus:border-slate-400 focus:bg-white focus:outline-none disabled:opacity-50"
        />

        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-slate-400">
            {pending
              ? "Calling LLM…"
              : deviceId
                ? `${knowledgeType === "wiki" ? "Patient wiki" : "RAG"} enabled · ${deviceId}`
                : "No device selected — chat without knowledge base"}
          </p>
          <button
            type="submit"
            disabled={pending || prompt.trim().length === 0}
            className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-5 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? <DotPulse /> : null}
            {pending ? "Sending" : "Send"}
          </button>
        </div>
      </form>

      {pending && history.length === 0 ? <Skeleton /> : null}

      {history.length === 0 && !pending ? <EmptyHint /> : null}

      <ul className="space-y-4">
        {history.map((entry, i) => (
          <HistoryRow key={entry.id} entry={entry} index={history.length - i} />
        ))}
      </ul>
    </section>
  );
}

function HistoryRow({
  entry,
  index,
}: {
  entry: HistoryEntry;
  index: number;
}): React.ReactElement {
  return (
    <li
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm animate-[fadeUp_240ms_ease-out_both]"
      style={{ animationDelay: "40ms" }}
    >
      <div className="mb-3 flex items-baseline justify-between">
        <div className="text-xs font-medium uppercase tracking-wider text-slate-400">
          #{index} · User
        </div>
        <div className="font-mono text-xs text-slate-400">{formatTime(entry.sentAt)}</div>
      </div>
      <p className="whitespace-pre-wrap text-sm text-slate-700">{entry.prompt}</p>

      <div className="mt-4 border-t border-slate-100 pt-4">
        <div className="mb-2 flex items-baseline justify-between">
          <div className="text-xs font-medium uppercase tracking-wider text-emerald-600">
            Andy · Assistant
          </div>
          <OutcomeMeta outcome={entry.outcome} />
        </div>
        <OutcomeBody outcome={entry.outcome} />
      </div>
    </li>
  );
}

function OutcomeMeta({ outcome }: { outcome: ChatOutcome }): React.ReactElement {
  if (outcome.kind === "ok") {
    return (
      <div className="font-mono text-xs text-slate-400">
        {outcome.durationMs}ms · {outcome.provider}
        {outcome.emotion ? ` · emotion: ${outcome.emotion}` : ""}
        {outcome.degraded ? " · fallback" : ""}
      </div>
    );
  }
  return (
    <div className="font-mono text-xs text-rose-600">HTTP {outcome.status}</div>
  );
}

function OutcomeBody({ outcome }: { outcome: ChatOutcome }): React.ReactElement {
  if (outcome.kind === "ok") {
    return (
      <p className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-slate-900">
        {outcome.reply}
      </p>
    );
  }
  return (
    <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
      {outcome.message}
    </div>
  );
}

function EmptyHint(): React.ReactElement {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 px-6 py-10 text-center text-sm text-slate-500">
      Send a prompt to call <span className="font-mono">POST /api/chat</span>.
      <br />
      The response will appear here with timing and provider info.
    </div>
  );
}

/**
 * Device selector + KB badge.
 *
 * - "No device" → chat without RAG (LLM only).
 * - Picking a device attaches the per-device retrieval tool to the agent.
 * - Shows live doc count next to the dropdown.
 * - "Manage KB" jumps to the device's admin page.
 */
function DeviceToolbar({
  devices,
  deviceId,
  onChange,
  knowledgeType,
  kbCount,
}: {
  devices: DeviceStatus[];
  deviceId: string;
  onChange: (next: string) => void;
  knowledgeType: "rag" | "wiki";
  kbCount: number | null;
}): React.ReactElement {
  const selected = useMemo(
    () => devices.find((d) => d.deviceId === deviceId),
    [devices, deviceId],
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-slate-500">
          Device
        </label>
        <select
          value={deviceId}
          onChange={(e) => onChange(e.target.value)}
          disabled={devices.length === 0}
          className="min-w-[180px] rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm focus:border-slate-400 focus:bg-white focus:outline-none disabled:opacity-50"
        >
          <option value="">
            {devices.length === 0
              ? "No devices online yet"
              : "— No device (LLM only) —"}
          </option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.displayName
                ? `${d.displayName} (${d.deviceId})`
                : d.deviceId}
            </option>
          ))}
        </select>

        {selected ? (
          <DeviceStatusBadge status={selected.status} />
        ) : null}

        <KbBadge
          loading={kbCount === null && Boolean(deviceId)}
          count={kbCount}
          deviceId={deviceId}
          knowledgeType={knowledgeType}
        />

        {deviceId ? (
          <div className="ml-auto flex items-center gap-2">
            <Link
              href={`/devices/${encodeURIComponent(deviceId)}/workspace`}
              className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-900 transition hover:border-slate-400 hover:bg-slate-50"
            >
              工作区 →
            </Link>
            <Link
              href={`/devices/${encodeURIComponent(deviceId)}/rag`}
              className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-900 transition hover:border-slate-400 hover:bg-slate-50"
            >
              Manage KB →
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DeviceStatusBadge({
  status,
}: {
  status: DeviceConnectionStatus;
}): React.ReactElement {
  const online = status === "online";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
        online
          ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
          : "bg-rose-50 text-rose-700 ring-1 ring-rose-200"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${online ? "bg-emerald-500" : "bg-rose-500"}`}
        aria-hidden="true"
      />
      {online ? "online" : "offline"}
    </span>
  );
}

function KbBadge({
  loading,
  count,
  deviceId,
  knowledgeType,
}: {
  loading: boolean;
  count: number | null;
  deviceId: string;
  knowledgeType: "rag" | "wiki";
}): React.ReactElement {
  if (!deviceId) return <span />;
  const label = knowledgeType === "wiki" ? "Wiki" : "KB";
  const unit = knowledgeType === "wiki" ? "file" : "doc";
  if (loading) {
    return (
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
        {label}: …
      </span>
    );
  }
  const n = count ?? 0;
  return (
    <span
      title={`${n} ${unit}${n === 1 ? "" : "s"} in this device's ${knowledgeType === "wiki" ? "workspace" : "knowledge base"}`}
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        n > 0
          ? "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200"
          : "bg-slate-100 text-slate-500"
      }`}
    >
      {label}: {n} {unit}
      {n === 1 ? "" : "s"}
    </span>
  );
}

function Skeleton(): React.ReactElement {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 h-3 w-24 rounded bg-slate-200" />
      <div className="mb-2 h-3 w-full rounded bg-slate-100" />
      <div className="h-3 w-2/3 rounded bg-slate-100" />
    </div>
  );
}

function DotPulse(): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white [animation-delay:300ms]" />
    </span>
  );
}

function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function postChat(prompt: string, deviceId?: string): Promise<ChatOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        deviceId ? { prompt, device_id: deviceId } : { prompt },
      ),
      signal: controller.signal,
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (res.ok) {
      return {
        kind: "ok",
        reply: String(data.reply ?? ""),
        durationMs: Number(data.duration_ms ?? 0),
        provider: String(data.provider ?? "unknown"),
        emotion: typeof data.emotion === "string" ? data.emotion : undefined,
        degraded: Boolean(data.degraded),
        reason: typeof data.reason === "string" ? data.reason : undefined,
      };
    }

    return {
      kind: "error",
      status: res.status,
      message:
        typeof data.error === "string" ? data.error : `HTTP ${res.status}`,
      timeoutMs: typeof data.timeout_ms === "number" ? data.timeout_ms : undefined,
    };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return {
      kind: "error",
      status: aborted ? 504 : 0,
      message: aborted
        ? `Request aborted after ${REQUEST_TIMEOUT_MS / 1000}s (LLM did not respond in time)`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
