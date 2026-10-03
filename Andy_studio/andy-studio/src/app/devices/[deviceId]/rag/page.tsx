import RagManager from "./RagManager";
import SystemPromptEditor from "./SystemPromptEditor";
import { listDocuments } from "@/services/rag/admin";
import { findDeviceRow } from "@/lib/device/device-lookup";
import { getDeviceSystemPrompt } from "@/services/ai/device-prompt-store";
import { AppShell } from "../../../_components/app-shell";
import { StatusBadge } from "../../../_components/ui";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  params: Promise<{ deviceId: string }>;
}

export default async function DeviceRagPage({
  params,
}: PageProps): Promise<React.ReactElement> {
  const { deviceId } = await params;

  const row = await findDeviceRow(deviceId);
  const device = row ? { status: row.lastSeenAt ? "seen" : "offline" } : null;

  let docs: Awaited<ReturnType<typeof listDocuments>> = [];
  let loadError: string | null = null;
  try {
    docs = listDocuments(deviceId);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  const devicePrompt = getDeviceSystemPrompt(deviceId) ?? "";

  return (
    <AppShell
      pathname="/devices"
      breadcrumbs={[
        { label: "设备", href: "/devices" },
        { label: deviceId, href: `/devices/${encodeURIComponent(deviceId)}` },
        { label: "知识库" },
      ]}
      eyebrow={deviceId}
      title="设备知识库"
      description={
        device
          ? `设备 ${deviceId} 的 RAG 知识库与系统 prompt 覆盖。`
          : `设备 ${deviceId} 尚未上报过心跳,但知识库可继续编辑。`
      }
      actions={
        device ? (
          <StatusBadge tone={device.status === "seen" ? "success" : "neutral"}>
            {device.status === "seen" ? "已上报心跳" : "尚未上报心跳"}
          </StatusBadge>
        ) : undefined
      }
    >
      {loadError ? (
        <div className="mb-6 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {loadError}
        </div>
      ) : null}

      <SystemPromptEditor deviceId={deviceId} initialPrompt={devicePrompt} />

      <RagManager deviceId={deviceId} initialDocs={docs} />
    </AppShell>
  );
}