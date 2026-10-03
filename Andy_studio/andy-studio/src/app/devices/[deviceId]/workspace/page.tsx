import Link from "next/link";

import WorkspaceManager from "./WorkspaceManager";
import { AppShell } from "../../../_components/app-shell";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  params: Promise<{ deviceId: string }>;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default async function DeviceWorkspacePage({
  params,
}: PageProps): Promise<React.ReactElement> {
  const { deviceId: rawDeviceId } = await params;
  const deviceId = safeDecode(rawDeviceId);

  return (
    <AppShell
      pathname="/devices"
      breadcrumbs={[
        { label: "设备", href: "/devices" },
        { label: deviceId, href: `/devices/${encodeURIComponent(deviceId)}` },
        { label: "工作区" },
      ]}
      eyebrow={deviceId}
      title="患者工作区"
      description="设备 raw/ 原始资料与 wiki/ 自动维护的知识库。"
      actions={
        <Link
          href={`/devices/${encodeURIComponent(deviceId)}`}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-900 hover:border-slate-400 hover:bg-slate-100"
        >
          返回设备详情
        </Link>
      }
    >
      <WorkspaceManager deviceId={deviceId} />
    </AppShell>
  );
}
