import Link from "next/link";
import { notFound } from "next/navigation";

import HistoryManager from "./HistoryManager";
import NotSignedIn from "../../../_components/not-signed-in";
import { AppShell } from "../../../_components/app-shell";
import { getConsoleSession } from "@/lib/page-auth";
import { findDeviceRow } from "@/lib/device/device-lookup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function DeviceHistoryPage({
  params,
}: { params: Promise<{ deviceId: string }> }): Promise<React.ReactElement> {
  const session = await getConsoleSession();
  if (!session.ok) return <NotSignedIn />;
  const { deviceId } = await params;
  const device = await findDeviceRow(deviceId);
  if (!device || device.deletedAt) notFound();

  const label = device.alias ?? device.deviceId;

  return (
    <AppShell
      pathname="/devices"
      breadcrumbs={[
        { label: "设备", href: "/devices" },
        { label: label, href: `/devices/${encodeURIComponent(deviceId)}` },
        { label: "聊天历史" },
      ]}
      eyebrow={deviceId}
      title={`聊天历史 · ${label}`}
      description="仅管理员可查看和删除数据库中的原始聊天记录。"
      actions={
        <Link
          href={`/devices/${encodeURIComponent(deviceId)}`}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-900 hover:border-slate-400 hover:bg-slate-100"
        >
          返回设备详情
        </Link>
      }
    >
      <HistoryManager deviceId={deviceId} />
    </AppShell>
  );
}
