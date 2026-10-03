"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface WorkspaceFile {
  path: string;
  virtualPath: string;
  size: number;
  modifiedAt: number;
}

interface WorkspaceResponse {
  deviceId: string;
  files: { raw: WorkspaceFile[]; wiki: WorkspaceFile[] };
}

interface UploadResponse {
  deviceId: string;
  filename: string;
  converter: string;
  virtualPath: string;
  sizeBytes: number;
  markdownChars: number;
}

interface FileResponse {
  deviceId: string;
  path: string;
  content: string;
}

interface NightlyResponse {
  ok: true;
  deviceId: string;
  date: string;
  messageCount: number;
  reply: string;
  changedFiles: string[];
  durationMs: number;
  skipped: boolean;
}

interface IngestResponse {
  ok: true;
  deviceId: string;
  rawPath: string;
  reply: string;
  changedFiles: string[];
  durationMs: number;
}

interface WorkspaceManagerProps {
  deviceId: string;
}

type Toast =
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

const EMPTY_FILES: WorkspaceResponse["files"] = { raw: [], wiki: [] };
const PREVIEW_MAX_CHARS = 20_000;
const UPLOAD_ACCEPT = ".md,.markdown,.txt,.json,.csv,.pdf,.docx";

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? `HTTP ${res.status}`;
}

function shanghaiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export default function WorkspaceManager({
  deviceId,
}: WorkspaceManagerProps): React.ReactElement {
  const base = `/api/workspace/${encodeURIComponent(deviceId)}`;

  const [files, setFiles] = useState<WorkspaceResponse["files"]>(EMPTY_FILES);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const [nightlyRunning, setNightlyRunning] = useState(false);
  const [nightlyResult, setNightlyResult] = useState<NightlyResponse | null>(null);
  const [nightlyError, setNightlyError] = useState<string | null>(null);

  const [ingestingPath, setIngestingPath] = useState<string | null>(null);
  const [ingestResults, setIngestResults] = useState<
    Record<string, { reply: string; changedFiles: string[] }>
  >({});

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(base, { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as WorkspaceResponse;
      setFiles(data.files);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(base, { cache: "no-store" });
        if (!res.ok) throw new Error(await readError(res));
        const data = (await res.json()) as WorkspaceResponse;
        if (cancelled) return;
        setFiles(data.files);
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [base]);

  useEffect(() => {
    if (previewPath && previewRef.current) {
      previewRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [previewPath]);

  const upload = useCallback(async () => {
    if (!selectedFile || uploading) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.set("file", selectedFile);
      const res = await fetch(`${base}/upload`, { method: "POST", body: fd });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as UploadResponse;
      setToast({
        kind: "info",
        text: `已上传 ${data.filename} · converter=${data.converter} → ${data.virtualPath} (${formatBytes(data.sizeBytes)})`,
      });
      setSelectedFile(null);
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
  }, [base, selectedFile, uploading, reload]);

  const openPreview = useCallback(
    async (path: string) => {
      setPreviewPath(path);
      setPreviewContent(null);
      setPreviewError(null);
      setPreviewLoading(true);
      try {
        const res = await fetch(`${base}/file?path=${encodeURIComponent(path)}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(await readError(res));
        const data = (await res.json()) as FileResponse;
        setPreviewContent(data.content);
      } catch (err) {
        setPreviewError(err instanceof Error ? err.message : String(err));
      } finally {
        setPreviewLoading(false);
      }
    },
    [base],
  );

  const runNightly = useCallback(async () => {
    if (nightlyRunning) return;
    setNightlyRunning(true);
    setNightlyError(null);
    try {
      const res = await fetch(`${base}/nightly`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: shanghaiToday() }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as NightlyResponse;
      setNightlyResult(data);
    } catch (err) {
      setNightlyError(err instanceof Error ? err.message : String(err));
    } finally {
      setNightlyRunning(false);
    }
  }, [base, nightlyRunning]);

  const ingest = useCallback(
    async (path: string) => {
      if (ingestingPath) return;
      setIngestingPath(path);
      try {
        const res = await fetch(`${base}/ingest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        if (!res.ok) throw new Error(await readError(res));
        const data = (await res.json()) as IngestResponse;
        const changed = data.changedFiles ?? [];
        setIngestResults((prev) => ({
          ...prev,
          [path]: { reply: data.reply, changedFiles: changed },
        }));
        setToast({
          kind: changed.length > 0 ? "info" : "error",
          text:
            changed.length > 0
              ? `已 ingest ${path} · 更新 ${changed.length} 个文件（${data.durationMs}ms）`
              : `ingest ${path} 未写入任何 wiki 文件（agent 可能只输出了计划），请重试`,
        });
        await reload();
      } catch (err) {
        setToast({
          kind: "error",
          text: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setIngestingPath(null);
      }
    },
    [base, ingestingPath, reload],
  );

  return (
    <section className="space-y-6">
      {toast ? (
        <div
          role="status"
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
          上传资料
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          支持{" "}
          <span className="font-mono">
            .md .markdown .txt .json .csv .pdf .docx
          </span>
          ，单个文件 ≤ 10&nbsp;MiB。文件会转换后存入{" "}
          <span className="font-mono">raw/uploads/</span>。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label
            htmlFor="workspace-upload"
            className={`inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 transition hover:border-slate-400 ${
              uploading ? "pointer-events-none opacity-50" : ""
            }`}
          >
            <span>选择文件…</span>
            <input
              id="workspace-upload"
              ref={fileRef}
              type="file"
              accept={UPLOAD_ACCEPT}
              onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
              disabled={uploading}
              className="hidden"
            />
          </label>
          {selectedFile ? (
            <span className="min-w-0 truncate font-mono text-xs text-slate-500">
              {selectedFile.name}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void upload()}
            disabled={!selectedFile || uploading}
            aria-busy={uploading}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {uploading ? (
              <span className="inline-flex items-center gap-2">
                <Spinner />
                上传中…
              </span>
            ) : (
              "上传"
            )}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
              触发夜间画像（模拟）
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              运行一次夜间 agent，读取当日对话并更新 Wiki。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void runNightly()}
            disabled={nightlyRunning}
            aria-busy={nightlyRunning}
            className="shrink-0 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-900 transition hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {nightlyRunning ? (
              <span className="inline-flex items-center gap-2">
                <Spinner />
                运行中…
              </span>
            ) : (
              "触发夜间画像"
            )}
          </button>
        </div>

        {nightlyError ? (
          <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {nightlyError}
          </p>
        ) : null}

        {nightlyResult ? (
          <div className="mt-3 space-y-2">
            <div className="grid grid-cols-3 gap-3">
              <Stat label="消息数" value={nightlyResult.messageCount} />
              <Stat label="耗时" value={`${nightlyResult.durationMs}ms`} />
              <Stat label="日期" value={nightlyResult.date} />
            </div>
            {nightlyResult.skipped ? (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
                skipped
              </p>
            ) : (
              <>
                {nightlyResult.changedFiles.length > 0 ? (
                  <p className="text-xs text-emerald-700">
                    更新文件：{nightlyResult.changedFiles.join(", ")}
                  </p>
                ) : (
                  <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    未写入任何 wiki 文件（agent 可能只输出了计划），请重试。
                  </p>
                )}
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700">
                  {nightlyResult.reply}
                </pre>
              </>
            )}
          </div>
        ) : null}
      </div>

      {previewPath ? (
        <div
          ref={previewRef}
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="min-w-0 truncate text-sm font-medium uppercase tracking-wide text-slate-500">
              预览 · <span className="font-mono normal-case">{previewPath}</span>
            </h2>
            <button
              type="button"
              onClick={() => {
                setPreviewPath(null);
                setPreviewContent(null);
                setPreviewError(null);
              }}
              className="shrink-0 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-500 transition hover:border-slate-300 hover:bg-slate-50"
            >
              关闭
            </button>
          </div>

          {previewLoading ? (
            <p className="mt-3 text-sm text-slate-500">加载中…</p>
          ) : previewError ? (
            <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {previewError}
            </p>
          ) : previewContent !== null ? (
            <>
              {previewContent.length > PREVIEW_MAX_CHARS ? (
                <p className="mt-2 text-xs text-amber-600">
                  内容较长，仅显示前 {PREVIEW_MAX_CHARS.toLocaleString()} 个字符（共{" "}
                  {previewContent.length.toLocaleString()} 字符）。
                </p>
              ) : null}
              <pre
                tabIndex={0}
                aria-label={`文件预览 ${previewPath}`}
                className="mt-3 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700"
              >
                {previewContent.length > PREVIEW_MAX_CHARS
                  ? `${previewContent.slice(0, PREVIEW_MAX_CHARS)}\n\n… [truncated]`
                  : previewContent}
              </pre>
            </>
          ) : null}
        </div>
      ) : null}

      {loadError ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          加载工作区失败：{loadError}
        </div>
      ) : null}

      <FileSection
        title={`原始资料 raw/ (${files.raw.length})`}
        files={files.raw}
        emptyText={
          loading ? "加载中…" : "暂无原始资料，请上传文件。"
        }
        allowIngest
        onPreview={(p) => void openPreview(p)}
        onIngest={(p) => void ingest(p)}
        ingestingPath={ingestingPath}
        ingestResults={ingestResults}
        activePath={previewPath}
      />

      <FileSection
        title={`Wiki (${files.wiki.length})`}
        files={files.wiki}
        emptyText={loading ? "加载中…" : "Wiki 尚未初始化。"}
        allowIngest={false}
        onPreview={(p) => void openPreview(p)}
        onIngest={(p) => void ingest(p)}
        ingestingPath={ingestingPath}
        ingestResults={ingestResults}
        activePath={previewPath}
      />
    </section>
  );
}

function FileSection({
  title,
  files,
  emptyText,
  allowIngest,
  onPreview,
  onIngest,
  ingestingPath,
  ingestResults,
  activePath,
}: {
  title: string;
  files: WorkspaceFile[];
  emptyText: string;
  allowIngest: boolean;
  onPreview: (path: string) => void;
  onIngest: (path: string) => void;
  ingestingPath: string | null;
  ingestResults: Record<string, { reply: string; changedFiles: string[] }>;
  activePath: string | null;
}): React.ReactElement {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
        {title}
      </h2>

      {files.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">{emptyText}</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {files.map((file) => {
            const ingestResult = ingestResults[file.path];
            const busy = ingestingPath === file.path;
            return (
              <li key={file.path} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => onPreview(file.path)}
                    aria-pressed={activePath === file.path}
                    className="group min-w-0 flex-1 text-left"
                  >
                    <span
                      className={`block truncate font-mono text-sm text-slate-900 group-hover:underline ${
                        activePath === file.path ? "underline" : ""
                      }`}
                    >
                      {file.path}
                    </span>
                    <span className="mt-1 block text-xs text-slate-400">
                      {formatBytes(file.size)} · {formatTime(file.modifiedAt)}
                    </span>
                  </button>
                  {allowIngest ? (
                    <button
                      type="button"
                      onClick={() => onIngest(file.path)}
                      disabled={busy || ingestingPath !== null}
                      aria-busy={busy}
                      className="shrink-0 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busy ? "Ingesting…" : "Ingest 到 Wiki"}
                    </button>
                  ) : null}
                </div>
                {ingestResult ? (
                  <div className="mt-2 space-y-1">
                    {ingestResult.changedFiles.length > 0 ? (
                      <p className="text-[11px] text-emerald-700">
                        更新：{ingestResult.changedFiles.join(", ")}
                      </p>
                    ) : (
                      <p className="text-[11px] text-amber-700">
                        未写入任何 wiki 文件，请重试
                      </p>
                    )}
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600">
                      {ingestResult.reply}
                    </pre>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: string | number;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold text-slate-900">
        {value}
      </div>
    </div>
  );
}

function Spinner(): React.ReactElement {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
      />
    </svg>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
