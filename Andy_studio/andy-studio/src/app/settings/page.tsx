import SettingsForm from "./SettingsForm";
import { ensureSettingsLoaded } from "@/services/ai/settings-store";
import { listProviders, getActiveProviderName } from "@/services/ai/provider-store";
import { AppShell } from "../_components/app-shell";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function SettingsPage(): Promise<React.ReactElement> {
  const [settings, providers, activeName] = await Promise.all([
    ensureSettingsLoaded(),
    listProviders(),
    getActiveProviderName(),
  ]);

  return (
    <AppShell
      pathname="/settings"
      title="模型设置"
      description="切换本地 Ollama / 云端 API,管理温度、思考模式与最大 token。"
    >
      <SettingsForm
        initial={{
          temperature: settings.temperature,
          thinking: settings.thinking,
          maxTokens: settings.maxTokens,
        }}
        providers={providers.map((p) => ({
          name: p.name,
          displayName: p.displayName,
          kind: p.kind,
          baseUrl: p.baseUrl,
          model: p.model,
          apiKeyHint: p.apiKeyHint,
          supportsThinking: p.supportsThinking,
        }))}
        activeName={activeName}
      />
    </AppShell>
  );
}