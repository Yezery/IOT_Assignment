import Link from "next/link";
import { notFound } from "next/navigation";

import { db } from "@/storage/db";
import { getConsoleSession } from "@/lib/page-auth";
import NotSignedIn from "../../_components/not-signed-in";
import { AppShell } from "../../_components/app-shell";
import { Panel, SectionHeader, Stat, StatusBadge } from "../../_components/ui";
import { DeviceActions } from "./device-actions";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, { tone: string; label: string }> = {
  pending: { tone: "warning", label: "待激活" },
  claimed: { tone: "success", label: "已激活" },
  expired: { tone: "neutral", label: "已过期" },
  revoked: { tone: "danger", label: "已吊销" },
};

function formatTime(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export default async function DeviceDetailPage({
  params,
}: {
  params: Promise<{ deviceId: string }>;
}): Promise<React.ReactElement> {
  const session = await getConsoleSession();
  if (!session.ok) return <NotSignedIn />;

  const { deviceId } = await params;
  const row = await db.device.findFirst({ where: { OR: [{ deviceId }, { clientId: deviceId }] } });
  if (!row || row.deletedAt) notFound();

  const [activations, tokens] = await Promise.all([
    db.activation.findMany({
      where: { deviceId: row.id },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { claimedBy: true },
    }),
    db.deviceToken.findMany({
      where: { deviceId: row.id, revokedAt: null },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);

  const title = row.alias ? `${row.alias} (${row.deviceId})` : row.deviceId;
  const status = STATUS_BADGE[row.status] ?? { tone: "neutral", label: row.status };

  return (
    <AppShell
      pathname="/devices"
      breadcrumbs={[
        { label: "设备", href: "/devices" },
        { label: row.alias ?? row.deviceId },
      ]}
      eyebrow={row.deviceId}
      title={title}
      description={`内部 ID ${row.id.toString()} · 客户端 ID ${row.clientId}`}
      actions={
        <>
          <Link
            href={`/devices/${encodeURIComponent(deviceId)}/history`}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-900 hover:border-slate-400 hover:bg-slate-100"
          >
            聊天历史
          </Link>
          <Link
            href={`/devices/${encodeURIComponent(deviceId)}/rag`}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-900 hover:border-slate-400 hover:bg-slate-100"
          >
            知识库
          </Link>
          <Link
            href={`/devices/${encodeURIComponent(deviceId)}/workspace`}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-900 hover:border-slate-400 hover:bg-slate-100"
          >
            工作区
          </Link>
          <DeviceActions
            deviceId={deviceId}
            displayName={row.alias ?? row.deviceId}
          />
        </>
      }
    >
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="板卡" value={`${row.boardName ?? "—"} (${row.board})`} />
        <Stat label="变体" value={row.variant} />
        <Stat label="固件" value={row.appVersion ?? "—"} />
        <Stat label="序列号" value={row.serialNumber ?? "—"} />
        <Stat label="状态" value={<StatusBadge tone={status.tone}>{status.label}</StatusBadge>} />
        <Stat label="激活时间" value={formatTime(row.activatedAt)} />
        <Stat label="最后心跳" value={formatTime(row.lastSeenAt)} />
        <Stat label="入网时间" value={formatTime(row.createdAt)} />
      </div>

      <Panel title="聊天历史" description="查看、按日期删除该设备的数据库聊天记录。" className="mb-6">
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500">
            删除操作不可撤销。Wiki 摘要 / 派生文件不会自动删除。
          </p>
          <Link
            href={`/devices/${encodeURIComponent(deviceId)}/history`}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
          >
            打开历史 →
          </Link>
        </div>
      </Panel>

      <div className="mb-6">
        <SectionHeader title="最近激活" description="与本设备关联的激活码。" />
        <Panel>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">code</th>
                <th className="px-3 py-2 text-left font-medium">状态</th>
                <th className="px-3 py-2 text-left font-medium">创建时间</th>
                <th className="px-3 py-2 text-left font-medium">过期时间</th>
                <th className="px-3 py-2 text-left font-medium">认领人</th>
              </tr>
            </thead>
            <tbody>
              {activations.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-sm text-slate-500">
                    暂无激活记录。
                  </td>
                </tr>
              ) : (
                activations.map((a) => {
                  const meta = STATUS_BADGE[a.status] ?? { tone: "neutral", label: a.status };
                  return (
                    <tr key={a.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-mono text-xs">{a.code}</td>
                      <td className="px-3 py-2">
                        <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                      </td>
                      <td className="px-3 py-2 text-xs">{formatTime(a.createdAt)}</td>
                      <td className="px-3 py-2 text-xs">{formatTime(a.expiresAt)}</td>
                      <td className="px-3 py-2 text-xs">{a.claimedBy?.email ?? "—"}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </Panel>
      </div>

      <div>
        <SectionHeader title="当前 Token" description="尚未吊销的设备 JWT 凭据。" />
        <Panel>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">token (前缀)</th>
                <th className="px-3 py-2 text-left font-medium">创建时间</th>
                <th className="px-3 py-2 text-left font-medium">过期时间</th>
              </tr>
            </thead>
            <tbody>
              {tokens.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-sm text-slate-500">
                    暂无活跃 token。
                  </td>
                </tr>
              ) : (
                tokens.map((t) => (
                  <tr key={t.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-mono text-xs">{t.token.slice(0, 16)}…</td>
                    <td className="px-3 py-2 text-xs">{formatTime(t.createdAt)}</td>
                    <td className="px-3 py-2 text-xs">{formatTime(t.expiresAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>
      </div>
    </AppShell>
  );
}