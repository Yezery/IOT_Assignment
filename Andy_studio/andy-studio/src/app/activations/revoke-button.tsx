"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { DangerButton, SecondaryButton, Toast } from "@/app/_components/ui";

export type RevokeableRow = {
  id: string;
  code: string;
  status: string;
};

export function RevokeActivationButton({
  activationId,
  code,
  status,
}: {
  activationId: string;
  code: string;
  status: string;
}): React.ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (status === "revoked" || status === "claimed") {
    return <span className="text-xs text-slate-400">—</span>;
  }

  const revoke = (): void => {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await fetch(`/api/v1/activations/${encodeURIComponent(activationId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setInfo(`激活码 ${code} 已吊销。`);
      setConfirming(false);
      router.refresh();
    });
  };

  return (
    <>
      <DangerButton
        type="button"
        onClick={() => setConfirming(true)}
        disabled={pending}
      >
        {pending ? "处理中…" : "吊销"}
      </DangerButton>
      {confirming ? (
        <ConfirmModal
          title="吊销激活码"
          pending={pending}
          onCancel={() => setConfirming(false)}
          onConfirm={revoke}
          body={
            <>
              确认吊销 <span className="font-mono">{code}</span> ? 之后将无法再被设备领取。
            </>
          }
        />
      ) : null}
      {error ? <Toast kind="error">{error}</Toast> : null}
      {info ? <Toast kind="info">{info}</Toast> : null}
    </>
  );
}

export function BulkRevokeToolbar({ rows }: { rows: RevokeableRow[] }): React.ReactElement {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const selectable = useMemo(
    () => rows.filter((r) => r.status !== "revoked" && r.status !== "claimed"),
    [rows],
  );
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
  const partial = !allSelected && selectable.some((r) => selected.has(r.id));

  // Clear selection when the rows array identity changes (e.g. after refresh).
  useEffect(() => {
    const t = window.setTimeout(() => setSelected(new Set()), 0);
    return () => window.clearTimeout(t);
  }, [rows]);

  const toggleAll = (): void => {
    setSelected(partial || allSelected ? new Set() : new Set(selectable.map((r) => r.id)));
  };

  const revoke = (): void => {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await fetch("/api/admin/activations/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected), reason: "admin console bulk" }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        revoked?: number;
        skipped?: { id: string; reason: string; status: string }[];
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setInfo(`已吊销 ${data.revoked ?? 0} 条激活码。`);
      setConfirming(false);
      setSelected(new Set());
      router.refresh();
    });
  };

  return (
    <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs">
      <div className="flex items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-slate-600">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = partial;
            }}
            onChange={toggleAll}
            aria-label="全选可吊销的激活码"
          />
          <span>全选可吊销 ({selectable.length})</span>
        </label>
        <span className="text-slate-500">已选 {selected.size} 条</span>
      </div>
      <div className="flex items-center gap-2">
        {error ? <Toast kind="error">{error}</Toast> : null}
        {info ? <Toast kind="info">{info}</Toast> : null}
        <DangerButton
          type="button"
          onClick={() => setConfirming(true)}
          disabled={pending || selected.size === 0}
        >
          {pending ? "处理中…" : `批量吊销 (${selected.size})`}
        </DangerButton>
      </div>
      {confirming ? (
        <ConfirmModal
          title={`批量吊销 ${selected.size} 条激活码`}
          pending={pending}
          onCancel={() => setConfirming(false)}
          onConfirm={revoke}
          body={
            <>
              确认将下列激活码标记为 <strong>已吊销</strong>:
              <ul className="mt-2 max-h-40 space-y-1 overflow-auto rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs">
                {selectable
                  .filter((r) => selected.has(r.id))
                  .map((r) => (
                    <li key={r.id} className="flex justify-between gap-3">
                      <span>{r.code}</span>
                      <span className="text-slate-500">{r.status}</span>
                    </li>
                  ))}
              </ul>
              <p className="mt-2 text-xs text-slate-500">
                已认领的激活码会被服务端自动跳过。
              </p>
            </>
          }
        />
      ) : null}
    </div>
  );
}

function ConfirmModal({
  title,
  body,
  pending,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: React.ReactNode;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <div
      role="alertdialog"
      aria-label={title}
      className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
        <div className="mt-2 text-sm text-slate-700">{body}</div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <SecondaryButton type="button" onClick={onCancel} disabled={pending}>
            取消
          </SecondaryButton>
          <DangerButton type="button" onClick={onConfirm} disabled={pending}>
            {pending ? "处理中…" : "确认"}
          </DangerButton>
        </div>
      </div>
    </div>
  );
}

function getAdminToken(): string {
  // The login flow stores an HttpOnly cookie; the server now also accepts
  // it directly, so the UI never needs to read the JWT. This helper is a
  // no-op kept for backwards-compatible call sites.
  if (typeof document === "undefined") return "";
  return "";
}

// Suppress unused warnings if the legacy helper is no longer referenced.
void getAdminToken;