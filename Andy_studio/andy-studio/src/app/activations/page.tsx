import { db } from "@/storage/db";
import { getConsoleSession } from "@/lib/page-auth";
import NotSignedIn from "../_components/not-signed-in";
import { AppShell } from "../_components/app-shell";
import { Panel, StatusBadge } from "../_components/ui";
import { CreateActivationForm } from "./create-activation-form";
import { BulkRevokeToolbar, RevokeActivationButton, type RevokeableRow } from "./revoke-button";
import { ConfirmActivationButton } from "./confirm-button";

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

export default async function ActivationsPage(): Promise<React.ReactElement> {
  const session = await getConsoleSession();
  if (!session.ok) return <NotSignedIn />;
  const role = session.role;

  const [rows, devices] = await Promise.all([
    db.activation.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { claimedBy: true },
    }),
    db.device.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);

  const deviceOptions = devices.map((d) => ({
    id: d.id.toString(),
    label: d.alias ? `${d.alias} (${d.deviceId})` : d.deviceId,
  }));

  const revokeRows: RevokeableRow[] = rows.map((r) => ({
    id: r.id.toString(),
    code: r.code,
    status: r.status,
  }));

  return (
    <AppShell
      pathname="/activations"
      title="激活码管理"
      description={
        role === "admin"
          ? "生成、跟踪、确认、吊销激活码。状态为「待激活」时点击「确认激活」可手动放行;正常情况由设备 HMAC 自动完成。"
          : "为设备签发激活码、查看历史激活记录、确认或吊销激活码。高风险操作需要管理员账号。"
      }
    >
      <div className="mb-6">
        <CreateActivationForm devices={deviceOptions} />
      </div>

      <Panel title={`激活码列表 (${rows.length})`} description="按创建时间倒序展示前 100 条。可多选后批量吊销。">
        <BulkRevokeToolbar rows={revokeRows} />

        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="w-10 px-3 py-2 text-left font-medium">
                <span className="sr-only">选择</span>
              </th>
              <th className="px-3 py-2 text-left font-medium">code</th>
              <th className="px-3 py-2 text-left font-medium">设备</th>
              <th className="px-3 py-2 text-left font-medium">状态</th>
              <th className="px-3 py-2 text-left font-medium">过期时间</th>
              <th className="px-3 py-2 text-left font-medium">创建时间</th>
              <th className="px-3 py-2 text-left font-medium">认领人</th>
              <th className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-sm text-slate-500">
                  暂无激活码。
                </td>
              </tr>
            ) : (
              rows.map((a) => {
                const meta = STATUS_BADGE[a.status] ?? { tone: "neutral", label: a.status };
                const selectable = a.status !== "revoked" && a.status !== "claimed";
                return (
                  <tr key={a.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        disabled={!selectable}
                        className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500 disabled:opacity-40"
                        aria-label={`选择 ${a.code}`}
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{a.code}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {a.deviceId ? `device:${a.deviceId.toString()}` : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                    </td>
                    <td className="px-3 py-2 text-xs">{formatTime(a.expiresAt)}</td>
                    <td className="px-3 py-2 text-xs">{formatTime(a.createdAt)}</td>
                    <td className="px-3 py-2 text-xs">
                      {a.claimedBy ? a.claimedBy.email : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <ConfirmActivationButton
                          activationId={a.id.toString()}
                          code={a.code}
                          status={a.status}
                        />
                        <RevokeActivationButton
                          activationId={a.id.toString()}
                          code={a.code}
                          status={a.status}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Panel>
    </AppShell>
  );
}
