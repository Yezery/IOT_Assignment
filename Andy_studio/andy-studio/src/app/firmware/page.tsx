import { getConsoleSession } from "@/lib/page-auth";
import NotSignedIn from "../_components/not-signed-in";
import { AppShell } from "../_components/app-shell";
import { EmptyState } from "../_components/ui";

export const dynamic = "force-dynamic";

export default async function FirmwarePage(): Promise<React.ReactElement> {
  const session = await getConsoleSession();
  if (!session.ok) return <NotSignedIn />;

  return (
    <AppShell
      pathname="/firmware"
      title="固件"
      description="发布管理、灰度策略、设备升级状态。"
    >
      <EmptyState
        title="即将推出"
        description="固件上传、板卡/变体匹配、灰度策略,以及通过 POST /api/v1/internal/ota 的签名 URL 分发。"
      />
    </AppShell>
  );
}
