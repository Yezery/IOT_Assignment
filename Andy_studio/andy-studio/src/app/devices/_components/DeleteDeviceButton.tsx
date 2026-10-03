"use client";

import { useState, useTransition } from "react";

import { DangerButton, Toast } from "@/app/_components/ui";

interface Props {
  deviceId: string;
  displayName: string;
  onDeleted?: () => void;
}

type Mode = "soft" | "hard";

export function DeleteDeviceButton({
  deviceId,
  displayName,
  onDeleted,
}: Props): React.ReactElement {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const label = displayName || deviceId;

  const remove = (mode: Mode): void => {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await fetch(`/api/admin/devices/${encodeURIComponent(deviceId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hard: mode === "hard", reason: "admin console" }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; mode?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setInfo(mode === "hard" ? "设备与相关数据已彻底删除。" : "设备已软删除,记录保留。");
      setConfirming(null);
      if (onDeleted) onDeleted();
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <DangerButton
        type="button"
        onClick={() => setConfirming("soft")}
        disabled={pending}
        title="软删除设备(可恢复)"
      >
        {pending ? "删除中…" : "删除"}
      </DangerButton>
      {confirming ? (
        <div
          role="alertdialog"
          aria-label="确认删除设备"
          className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/50 p-4"
          onClick={() => setConfirming(null)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-slate-900">删除设备「{label}」</h3>
            <p className="mt-2 text-sm text-slate-500">
              设备 ID: <span className="font-mono">{deviceId}</span>
            </p>

            <div className="mt-4 space-y-3 text-sm text-slate-700">
              <label className="flex items-start gap-3 rounded-md border border-slate-200 p-3">
                <input
                  type="radio"
                  className="mt-1"
                  name="delete-mode"
                  checked={confirming === "soft"}
                  onChange={() => setConfirming("soft")}
                />
                <span>
                  <strong className="block">软删除(推荐)</strong>
                  <span className="text-slate-500">
                    隐藏设备,工作区、聊天记录与 token 保留。若设备再次上线会自动恢复。
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 rounded-md border border-rose-200 bg-rose-50/40 p-3">
                <input
                  type="radio"
                  className="mt-1"
                  name="delete-mode"
                  checked={confirming === "hard"}
                  onChange={() => setConfirming("hard")}
                />
                <span>
                  <strong className="block text-rose-700">彻底删除</strong>
                  <span className="text-slate-500">
                    删除设备记录、其聊天历史与未撤销的 token。<strong>不可恢复</strong>。
                  </span>
                </span>
              </label>
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-100"
                onClick={() => setConfirming(null)}
                disabled={pending}
              >
                取消
              </button>
              <DangerButton type="button" onClick={() => remove(confirming)} disabled={pending}>
                {pending ? "处理中…" : confirming === "hard" ? "确认彻底删除" : "确认软删除"}
              </DangerButton>
            </div>
          </div>
        </div>
      ) : null}
      {error ? <Toast kind="error">{error}</Toast> : null}
      {info ? <Toast kind="info">{info}</Toast> : null}
    </div>
  );
}