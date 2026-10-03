"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { DocumentSummary } from "@/services/rag/admin";

interface RagManagerProps {
  deviceId: string;
  initialDocs: DocumentSummary[];
}

type Toast =
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

export default function RagManager({
  deviceId,
  initialDocs,
}: RagManagerProps): React.ReactElement {
  const [docs, setDocs] = useState<DocumentSummary[]>(initialDocs);
  const [toast, setToast] = useState<Toast | null>(null);

  const [docId, setDocId] = useState("");
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);

const fileRef = useRef<HTMLInputElement>(null);
const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/rag/${encodeURIComponent(deviceId)}/docs`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { docs: DocumentSummary[] };
      setDocs(data.docs);
    } catch (err) {
      setToast({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  }, [deviceId]);

  const submitText = useCallback(async () => {
    const trimmedId = docId.trim();
    const trimmedText = text.trim();
    if (!trimmedId || !trimmedText || submitting) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/rag/${encodeURIComponent(deviceId)}/docs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId: trimmedId, text: trimmedText }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { chunkIds: string[] };
      setToast({
        kind: "info",
        text: `Added "${trimmedId}" (${data.chunkIds.length} chunk${data.chunkIds.length === 1 ? "" : "s"})`,
      });
      setDocId("");
      setText("");
      await reload();
    } catch (err) {
      setToast({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  }, [deviceId, docId, text, submitting, reload]);

  const uploadFile = useCallback(
    async (file: File) => {
      setUploading(true);
      try {
        const fd = new FormData();
        fd.set("file", file);
        const res = await fetch(
          `/api/rag/${encodeURIComponent(deviceId)}/docs/file`,
          { method: "POST", body: fd },
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as {
          docId: string;
          filename: string;
          chunkIds: string[];
          sizeBytes: number;
        };
        setToast({
          kind: "info",
          text: `Uploaded ${data.filename} → "${data.docId}" (${data.chunkIds.length} chunk${data.chunkIds.length === 1 ? "" : "s"}, ${(data.sizeBytes / 1024).toFixed(1)} KiB)`,
        });
        if (fileRef.current) fileRef.current.value = "";
        await reload();
      } catch (err) {
        setToast({
          kind: "error",
          text: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setUploading(false);
      }
    },
    [deviceId, reload],
  );

  const removeDoc = useCallback(
    async (id: string) => {
      if (!confirm(`Delete document "${id}" and all its chunks?`)) return;
      try {
        const res = await fetch(
          `/api/rag/${encodeURIComponent(deviceId)}/docs?docId=${encodeURIComponent(id)}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { removed: number };
        setToast({
          kind: "info",
          text: `Removed "${id}" (${data.removed} chunks)`,
        });
        await reload();
      } catch (err) {
        setToast({
          kind: "error",
          text: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [deviceId, reload],
  );

  const clearAll = useCallback(async () => {
    if (
      !confirm(
        `Wipe EVERY document for device "${deviceId}"? This cannot be undone.`,
      )
    )
      return;
    try {
      const res = await fetch(`/api/rag/${encodeURIComponent(deviceId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { removed: number };
      setToast({
        kind: "info",
        text: `Wiped ${data.removed} chunk${data.removed === 1 ? "" : "s"}`,
      });
      await reload();
    } catch (err) {
      setToast({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  }, [deviceId, reload]);

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void uploadFile(file);
    },
    [uploadFile],
  );

  return (
    <section className="space-y-6">
      {toast ? (
        <div
          className={`rounded-md border px-4 py-2 text-sm ${
            toast.kind === "error"
              ? "border-rose-200 bg-rose-50 text-rose-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {toast.text}
        </div>
      ) : null}

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Add text
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitText();
          }}
          className="mt-3 space-y-3"
        >
          <input
            value={docId}
            onChange={(e) => setDocId(e.target.value)}
            placeholder="docId (e.g. wifi-setup)"
            disabled={submitting}
            className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm focus:border-slate-400 focus:bg-white focus:outline-none disabled:opacity-50"
          />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste device-specific knowledge here…"
            disabled={submitting}
            rows={6}
            className="w-full resize-y rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:border-slate-400 focus:bg-white focus:outline-none disabled:opacity-50"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={
                submitting ||
                docId.trim().length === 0 ||
                text.trim().length === 0
              }
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? "Adding…" : "Add document"}
            </button>
          </div>
        </form>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Upload file
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          Supports <span className="font-mono">.md</span>,{" "}
          <span className="font-mono">.txt</span>,{" "}
          <span className="font-mono">.markdown</span>. Max 1&nbsp;MiB.
          docId is derived from the filename unless you set it later.
        </p>
        <div className="mt-3">
          <label
            className={`inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 transition hover:border-slate-400 ${uploading ? "pointer-events-none opacity-50" : ""}`}
          >
            <span>{uploading ? "Uploading…" : "Choose file…"}</span>
            <input
              ref={fileRef}
              type="file"
              accept=".md,.txt,.markdown,text/plain,text/markdown"
              onChange={onFileChange}
              disabled={uploading}
              className="hidden"
            />
          </label>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
            Documents ({docs.length})
          </h2>
          {docs.length > 0 ? (
            <button
              type="button"
              onClick={() => void clearAll()}
              className="text-xs font-medium text-rose-600 underline-offset-2 hover:underline"
            >
              Clear all
            </button>
          ) : null}
        </div>

        {docs.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            No documents yet. Add text above or upload a file.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {docs.map((doc) => (
              <li
                key={doc.docId}
                className="flex items-start justify-between gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm text-slate-900">
                      {doc.docId}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      {doc.chunkCount} chunk{doc.chunkCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-slate-400">
                    Added {formatTime(doc.createdAt)}
                    {doc.lastChunkAt !== doc.createdAt
                      ? ` · last chunk ${formatTime(doc.lastChunkAt)}`
                      : ""}
                  </div>
                  {doc.sampleMetadata ? (
                    <pre className="mt-1 max-w-full overflow-hidden text-ellipsis whitespace-pre-wrap rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-500">
                      {truncate(doc.sampleMetadata, 120)}
                    </pre>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => void removeDoc(doc.docId)}
                  className="shrink-0 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-rose-600 transition hover:border-rose-300 hover:bg-rose-50"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}