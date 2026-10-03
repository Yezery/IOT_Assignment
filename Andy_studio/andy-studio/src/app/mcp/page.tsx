import { getConsoleSession } from "@/lib/page-auth";
import NotSignedIn from "../_components/not-signed-in";
import { AppShell } from "../_components/app-shell";
import { EmptyState } from "../_components/ui";

export const dynamic = "force-dynamic";

export default async function McpPage(): Promise<React.ReactElement> {
  const session = await getConsoleSession();
  if (!session.ok) return <NotSignedIn />;

  return (
    <AppShell
      pathname="/mcp"
      title="MCP"
      description="Model Context Protocol 服务注册与工具策略。"
    >
      <EmptyState
        title="即将推出"
        description="注册 stdio / http MCP 服务、工具白名单与按设备的工具覆盖。"
      />
    </AppShell>
  );
}
