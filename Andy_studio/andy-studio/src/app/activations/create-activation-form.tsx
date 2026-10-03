"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Panel, PrimaryButton, Toast } from "@/app/_components/ui";

interface DeviceOption {
  id: string;
  label: string;
}

export function CreateActivationForm({ devices }: { devices: DeviceOption[] }): React.ReactElement {
  const router = useRouter();
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    if (!deviceId && devices.length > 0) {
      queueMicrotask(() => setDeviceId(devices[0].id));
    }
  }, [devices, deviceId]);

  const submit = (): void => {
    if (!deviceId) {
      setError("请先选择一台设备");
      return;
    }
    setError(null);
    setCode(null);
    startTransition(async () => {
      // Same-origin admin UI: the session cookie is sent automatically.
      const res = await fetch("/api/v1/activations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ deviceId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setCode(data.code ?? null);
      router.refresh();
    });
  };

  return (
    <Panel
      title="创建激活码"
      description="为已注册的设备签发一次性激活码,设备端通过该码完成首次激活。"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-slate-500">
          <span className="mb-1 font-medium">设备</span>
          <select
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            disabled={pending || devices.length === 0}
            className="min-w-[260px] rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none disabled:opacity-50"
          >
            {devices.length === 0 ? (
              <option value="">暂无设备</option>
            ) : (
              devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))
            )}
          </select>
        </label>
        <PrimaryButton type="button" onClick={submit} disabled={pending || devices.length === 0}>
          {pending ? "创建中…" : "创建激活码"}
        </PrimaryButton>
      </div>
      {code ? (
        <Toast kind="info">
          新激活码: <span className="font-mono font-semibold">{code}</span>
        </Toast>
      ) : null}
      {error ? <Toast kind="error">{error}</Toast> : null}
      {devices.length === 0 ? (
        <p className="text-xs text-slate-500">
          当前还没有可绑定的设备,请先在设备管理中登记。
        </p>
      ) : null}
    </Panel>
  );
}