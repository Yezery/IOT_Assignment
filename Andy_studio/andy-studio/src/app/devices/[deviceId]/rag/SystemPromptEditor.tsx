"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Toast =
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

const MAX_LEN = 4000;

export default function SystemPromptEditor({
  deviceId,
  initialPrompt,
}: {
  deviceId: string;
  initialPrompt: string;
}): React.ReactElement {
  const [draft, setDraft] = useState(initialPrompt);
  const [saved, setSaved] = useState(initialPrompt);
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync on prop change (e.g. parent re-fetched after server reset).
  useEffect(() => {
    queueMicrotask(() => {
      setDraft(initialPrompt);
      setSaved(initialPrompt);
    });
  }, [initialPrompt]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const dirty = draft !== saved;

  const save = useCallback(
    async (text: string) => {
      setPending(true);
      setToast(null);
      try {
        const res = await fetch(
          `/api/devices/${encodeURIComponent(deviceId)}/system-prompt`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ systemPrompt: text }),
          },
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { systemPrompt: string };
        setSaved(data.systemPrompt);
        setDraft(data.systemPrompt);
        setToast({ kind: "info", text: "System prompt saved." });
      } catch (err) {
        setToast({ kind: "error", text: err instanceof Error ? err.message : String(err) });
      } finally {
        setPending(false);
      }
    },
    [deviceId],
  );

  // Debounce autosave — feels nicer than a save button for prose.
  useEffect(() => {
    if (!dirty || draft.length > MAX_LEN) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void save(draft), 1200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [draft, dirty, save]);

  const clearOverride = useCallback(async () => {
    if (!confirm("Clear the system-prompt override? The default SOUL will be used again.")) return;
    setPending(true);
    try {
      const res = await fetch(
        `/api/devices/${encodeURIComponent(deviceId)}/system-prompt`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaved("");
      setDraft("");
      setToast({ kind: "info", text: "Override cleared. Default SOUL in effect." });
    } catch (err) {
      setToast({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setPending(false);
    }
  }, [deviceId]);

  return (
    <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      {toast ? (
        <div
          className={`mb-3 rounded-md border px-3 py-2 text-xs ${
            toast.kind === "error"
              ? "border-rose-200 bg-rose-50 text-rose-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {toast.text}
        </div>
      ) : null}

      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
            System prompt (SOUL override)
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Replaces the default Andy persona for this device only. The
            shared RULES section is always appended.
          </p>
        </div>
        {saved ? (
          <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-indigo-200">
            override active
          </span>
        ) : (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
            using default
          </span>
        )}
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, MAX_LEN))}
        disabled={pending}
        rows={6}
        placeholder="e.g. 你是一个面向视障用户的家庭助理,语气更温和..."
        className="mt-3 w-full resize-y rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:bg-white focus:outline-none disabled:opacity-50"
      />

      <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
        <span>
          {draft.length} / {MAX_LEN} {pending ? "· saving…" : dirty ? "· edited" : ""}
        </span>
        {saved ? (
          <button
            type="button"
            onClick={() => void clearOverride()}
            disabled={pending}
            className="text-rose-600 underline-offset-2 hover:underline disabled:opacity-40"
          >
            clear override
          </button>
        ) : null}
      </div>
    </div>
  );
}