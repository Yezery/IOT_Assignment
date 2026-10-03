"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import type { DeviceStatus } from "@/types/device";

import { AppShell } from "../_components/app-shell";
import { EmptyState, Stat, StatusBadge } from "../_components/ui";
import { DeleteDeviceButton } from "./_components/DeleteDeviceButton";

interface DevicesResponse {
  devices: DeviceStatus[];
  counts: {
    total: number;
    online: number;
    offline: number;
  };
}

interface DashboardState {
  devices: DeviceStatus[];
  counts: DevicesResponse["counts"];
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
}

const POLL_INTERVAL_MS = 2000;
const EMPTY_COUNTS: DevicesResponse["counts"] = { total: 0, online: 0, offline: 0 };

const initialState: DashboardState = {
  devices: [],
  counts: EMPTY_COUNTS,
  loading: true,
  error: null,
  lastFetchedAt: null,
};

export default function DevicesPage(): React.ReactElement {
  const [state, setState] = useState<DashboardState>(initialState);
  const refetchRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const fetchOnce = async (): Promise<void> => {
      try {
        const res = await fetch("/api/devices", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as DevicesResponse;
        if (cancelled) return;
        setState({
          devices: data.devices,
          counts: data.counts,
          loading: false,
          error: null,
          lastFetchedAt: Date.now(),
        });
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    };

    refetchRef.current = fetchOnce;

    void fetchOnce();
    const timer = setInterval(fetchOnce, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  return (
    <AppShell
      pathname="/devices"
      title="设备列表"
      description="EMQX / MQTT 接入的设备实时状态。点进任一设备进入详情、知识库、历史或工作区。"
      actions={
        <span className="text-xs text-slate-500">
          {state.lastFetchedAt ? `更新于 ${formatRelative(state.lastFetchedAt)}` : "—"}
        </span>
      }
    >
      <section className="mb-6 grid grid-cols-3 gap-3">
        <Stat label="设备总数" value={state.counts.total} />
        <Stat label="在线" value={state.counts.online} tone="ok" />
        <Stat label="离线" value={state.counts.offline} tone="bad" />
      </section>

      {state.error ? (
        <div className="mb-6 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          加载设备失败: {state.error}
        </div>
      ) : null}

      {state.loading && state.devices.length === 0 ? (
        <EmptyState
          title="正在等待设备上线"
          description="打开任一 ESP32,设备将向 EMQX 发布 status 消息。"
        />
      ) : state.devices.length === 0 ? (
        <EmptyState
          title="暂无设备"
          description="还没有收到 device/+/status 消息。"
        />
      ) : (
        <ul className="grid gap-4">
          {state.devices.map((device) => (
            <DeviceCard
              key={device.deviceId}
              device={device}
              onAliasChange={() => void refetchRef.current()}
              onDeleted={() => void refetchRef.current()}
            />
          ))}
        </ul>
      )}

      <p className="mt-10 text-center text-xs text-slate-400">
        每 {POLL_INTERVAL_MS / 1000} 秒轮询一次 · 可后续升级为 SSE / WebSocket
      </p>
    </AppShell>
  );
}

function DeviceCard({
  device,
  onAliasChange,
  onDeleted,
}: {
  device: DeviceStatus;
  onAliasChange: () => void;
  onDeleted: () => void;
}): React.ReactElement {
  const online = device.status === "online";
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <DeviceNameEditor
            deviceId={device.deviceId}
            displayName={device.displayName}
            onSaved={onAliasChange}
          />
          <p className="mt-1 text-sm text-slate-500">
            Device ID: <span className="font-mono">{device.deviceId}</span>
          </p>
        </div>
        <DeviceStatusPill online={online} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-400">Board</dt>
          <dd className="text-slate-700">{device.boardName ?? device.board ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-400">MAC</dt>
          <dd className="font-mono text-slate-700">{device.mac ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-400">Firmware</dt>
          <dd className="text-slate-700">{device.appVersion ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-400">Last Seen</dt>
          <dd className="text-slate-700">{formatTimestamp(device.lastSeen)}</dd>
        </div>
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
        <Link
          href={`/devices/${encodeURIComponent(device.deviceId)}`}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-700"
        >
          打开详情
        </Link>
        <Link
          href={`/devices/${encodeURIComponent(device.deviceId)}/history`}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-900 transition hover:border-slate-400 hover:bg-slate-100"
        >
          聊天历史
        </Link>
        <Link
          href={`/devices/${encodeURIComponent(device.deviceId)}/rag`}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-900 transition hover:border-slate-400 hover:bg-slate-100"
        >
          知识库
        </Link>
        <Link
          href={`/devices/${encodeURIComponent(device.deviceId)}/workspace`}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-900 transition hover:border-slate-400 hover:bg-slate-100"
        >
          工作区
        </Link>
        <span className="ml-auto">
          <DeleteDeviceButton
            deviceId={device.deviceId}
            displayName={device.displayName ?? device.deviceId}
            onDeleted={onDeleted}
          />
        </span>
      </div>
    </li>
  );
}

/**
 * Inline display-name editor.
 *
 * - Shows current `displayName` (or the raw deviceId if none).
 * - Click the pencil → editable input, autosaves on Enter / blur.
 * - Esc cancels; empty input clears the alias (deviceId stays visible).
 * - Trash icon appears only when an alias is set.
 */
function DeviceNameEditor({
  deviceId,
  displayName,
  onSaved,
}: {
  deviceId: string;
  displayName: string | undefined;
  onSaved: () => void;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = useCallback(
    async (next: string) => {
      const trimmed = next.trim();
      if (trimmed === (displayName ?? "")) {
        setEditing(false);
        return;
      }
      setPending(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/devices/${encodeURIComponent(deviceId)}/alias`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ displayName: trimmed }),
          },
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        setEditing(false);
        onSaved();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPending(false);
      }
    },
    [deviceId, displayName, onSaved],
  );

  const clear = useCallback(async () => {
    if (!displayName) return;
    if (!confirm(`Clear the alias "${displayName}"?`)) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/devices/${encodeURIComponent(deviceId)}/alias`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }, [deviceId, displayName, onSaved]);

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save(draft);
              else if (e.key === "Escape") {
                setDraft(displayName ?? "");
                setEditing(false);
              }
            }}
            onBlur={() => void save(draft)}
            disabled={pending}
            maxLength={64}
            placeholder={deviceId}
            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-lg font-medium focus:border-slate-500 focus:outline-none disabled:opacity-50"
          />
          {pending ? (
            <span className="shrink-0 text-xs text-slate-400">saving…</span>
          ) : null}
        </div>
        {error ? (
          <span className="text-xs text-rose-600">{error}</span>
        ) : (
          <span className="text-xs text-slate-400">
            Enter to save · Esc to cancel · empty clears the alias
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Link
        href={`/devices/${encodeURIComponent(deviceId)}`}
        className="hover:underline"
      >
        <h2 className="truncate text-lg font-medium" title={displayName ?? deviceId}>
          {displayName ?? deviceId}
        </h2>
      </Link>
      <button
        type="button"
        aria-label="Rename device"
        title="Rename device"
        onClick={() => {
          setDraft(displayName ?? "");
          setEditing(true);
        }}
        className="rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
      >
        <PencilIcon />
      </button>
      {displayName ? (
        <button
          type="button"
          aria-label="Clear alias"
          title="Clear alias"
          onClick={() => void clear()}
          disabled={pending}
          className="rounded-md p-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
        >
          <TrashIcon />
        </button>
      ) : null}
    </div>
  );
}

function PencilIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function TrashIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

function DeviceStatusPill({ online }: { online: boolean }): React.ReactElement {
  return (
    <StatusBadge tone={online ? "success" : "danger"}>
      <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-emerald-500" : "bg-rose-500"}`} aria-hidden="true" />
      {online ? "在线" : "离线"}
    </StatusBadge>
  );
}

function formatTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function formatRelative(epochMs: number): string {
  const deltaSec = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (deltaSec < 1) return "just now";
  if (deltaSec === 1) return "1s ago";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  return `${Math.floor(deltaSec / 60)}m ago`;
}
