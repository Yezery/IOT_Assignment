import Link from "next/link";

import { getConsoleSession } from "@/lib/page-auth";
import { AppShell } from "./_components/app-shell";
import { Panel } from "./_components/ui";

const QUICK_LINKS = [
  {
    href: "/activations",
    title: "激活码管理",
    description: "为新上线的 ESP32 签发激活码,完成首次绑定。",
    badge: "最常用",
  },
  {
    href: "/devices",
    title: "设备列表",
    description: "实时查看已上线的 ESP32 设备、状态、固件版本。",
    badge: "核心",
  },
  {
    href: "/chat",
    title: "对话沙盒",
    description: "从浏览器直接联调 LLM 链路,选择设备则附带 RAG/Wiki 上下文。",
    badge: "调试",
  },
  {
    href: "/audit",
    title: "审计日志",
    description: "系统最近的认证、设备命令、AI 回复审计记录。",
    badge: "合规",
  },
  {
    href: "/settings",
    title: "模型设置",
    description: "切换本地 Ollama / 云端 API,管理温度、思考模式与最大 token。",
    badge: "模型",
  },
  {
    href: "/firmware",
    title: "固件",
    description: "OTA 升级、版本管理与板卡策略。",
    badge: "运维",
  },
];

export default async function HomePage(): Promise<React.ReactElement> {
  const session = await getConsoleSession();
  const role = session.ok ? session.role : null;

  return (
    <AppShell
      pathname="/"
      title="首页"
      description="Andy Studio 后台总览。下方给出最常用入口与设备激活的完整流程。"
    >
      <Panel
        title="新设备激活流程"
        description="ESP32 上电后,服务器会生成一次性激活码并通过 OTA 推给设备。"
      >
        <ol className="grid gap-3 text-sm text-slate-700 md:grid-cols-3">
          <li className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">第 1 步</div>
            <div className="mt-1 font-medium">设备自动生成激活码</div>
            <p className="mt-1 text-xs text-slate-500">
              设备首次请求 OTA 时,后台会签发 8 位激活码并推送给设备,同时显示在设备屏幕和 TTS 语音里。
            </p>
          </li>
          <li className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">第 2 步</div>
            <div className="mt-1 font-medium">后台确认设备已上线</div>
            <p className="mt-1 text-xs text-slate-500">
              进入「设备列表」确认设备在线。如果设备未出现,先确认 MQTT/UDP 凭据已配置并重启 ESP32。
            </p>
          </li>
          <li className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">第 3 步</div>
            <div className="mt-1 font-medium">在「激活码」列表中确认</div>
            <p className="mt-1 text-xs text-slate-500">
              系统生成的激活码已经写入「激活码」表格,无需手动创建。若状态显示「待激活」,
              通常设备会自动完成激活;遇到 HMAC 校验失败时,操作员可在「待激活」行点击「确认激活」手动放行。
            </p>
          </li>
        </ol>
        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
          <p>
            <strong>注意:</strong>设备激活失败时,设备会持续重试直到激活码过期。可在
            「激活码」页面将其设为「已吊销」并按设备重新签发一个。
          </p>
        </div>
      </Panel>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {QUICK_LINKS.map((card) => (
          <Link key={card.href} href={card.href} className="group">
            <Panel
              className="h-full transition group-hover:border-slate-400 group-hover:shadow-md"
              title={card.title}
              description={card.description}
              actions={null}
            >
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">{card.badge}</span>
                <span className="text-slate-400 transition group-hover:text-slate-700">进入 →</span>
              </div>
            </Panel>
          </Link>
        ))}
      </div>

      {!session.ok ? (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          你尚未登录,以上入口的设备数据需要登录后才能查看与操作。请先前往
          <Link href="/login" className="ml-1 font-medium underline">
            登录页
          </Link>
          。
        </div>
      ) : (
        <div className="mt-6 rounded-lg border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
          当前登录:
          <span className="ml-1 font-mono text-slate-700">{session.email}</span>
          ,角色
          <span className="ml-1 font-mono text-slate-700">{role}</span>
          。如需管理员能力,请使用 admin 账号重新登录。
        </div>
      )}
    </AppShell>
  );
}
