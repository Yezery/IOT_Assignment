import { db } from "@/storage/db";
import { getConsoleSession } from "@/lib/page-auth";
import NotSignedIn from "../_components/not-signed-in";
import { AppShell } from "../_components/app-shell";
import { Panel } from "../_components/ui";

export const dynamic = "force-dynamic";

function formatTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export default async function AuditPage(): Promise<React.ReactElement> {
  const session = await getConsoleSession();
  if (!session.ok) return <NotSignedIn />;

  const rows = await db.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <AppShell
      pathname="/audit"
      title="审计日志"
      description="系统最新的 100 条审计记录。"
      actions={
        <span className="text-xs text-slate-500">{rows.length} 条记录</span>
      }
    >
      <Panel>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">时间</th>
              <th className="px-3 py-2 text-left font-medium">操作者</th>
              <th className="px-3 py-2 text-left font-medium">动作</th>
              <th className="px-3 py-2 text-left font-medium">对象</th>
              <th className="px-3 py-2 text-left font-medium">载荷</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-sm text-slate-500">
                  暂无审计记录。
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const payload = r.payload ? JSON.stringify(r.payload) : "";
                return (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                      {formatTime(r.createdAt)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {r.actorType}
                      {r.actorId ? `:${r.actorId}` : ""}
                    </td>
                    <td className="px-3 py-2 text-xs font-mono">{r.action}</td>
                    <td className="px-3 py-2 text-xs">
                      {r.targetType}
                      {r.targetId ? `:${r.targetId}` : ""}
                    </td>
                    <td className="px-3 py-2 text-xs font-mono max-w-md truncate" title={payload}>
                      {payload}
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
