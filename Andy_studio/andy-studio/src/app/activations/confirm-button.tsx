"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { PrimaryButton, SecondaryButton, StatusBadge, Toast } from "@/app/_components/ui";

interface Props {
  activationId: string;
  code: string;
  status: string;
}

export function ConfirmActivationButton({
  activationId,
  code,
  status,
}: Props): React.ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Only show the action while the activation is still pending.
  if (status !== "pending") {
    return status === "claimed" ? (
      <StatusBadge tone="success">已激活</StatusBadge>
    ) : (
      <span className="text-xs text-slate-400">—</span>
    );
  }

  const confirm = (): void => {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await fetch(
        `/api/admin/activations/${encodeURIComponent(activationId)}/claim`,
        { method: "POST", credentials: "include" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        deviceId?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setInfo(`已为设备 ${data.deviceId ?? "?"} 确认激活。`);
      setConfirming(false);
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <PrimaryButton type="button" onClick={() => setConfirming(true)} disabled={pending}>
        {pending ? "处理中…" : "确认激活"}
      </PrimaryButton>
      {confirming ? (
        <div
          role="alertdialog"
          aria-label="确认激活设备"
          className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/50 p-4"
          onClick={() => setConfirming(false)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-slate-900">确认激活设备</h3>
            <p className="mt-2 text-sm text-slate-700">
              将激活码 <span className="font-mono">{code}</span> 标记为已激活,
              并把对应设备状态改为 <strong>已激活</strong>。
            </p>
            <p className="mt-2 text-xs text-slate-500">
              仅在设备无法自行通过 HMAC 校验时使用,例如固件端签名缺失或调试场景。
              正常激活应由设备在拿到激活码后自动完成。
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <SecondaryButton type="button" onClick={() => setConfirming(false)} disabled={pending}>
                取消
              </SecondaryButton>
              <PrimaryButton type="button" onClick={confirm} disabled={pending}>
                {pending ? "处理中…" : "确认激活"}
              </PrimaryButton>
            </div>
          </div>
        </div>
      ) : null}
      {error ? <Toast kind="error">{error}</Toast> : null}
      {info ? <Toast kind="info">{info}</Toast> : null}
    </div>
  );
}