import ChatPanel from "./ChatPanel";
import { AppShell } from "../_components/app-shell";

export default function ChatPage(): React.ReactElement {
  return (
    <AppShell
      pathname="/chat"
      title="对话沙盒"
      description="从浏览器直接调用 POST /api/chat,选择设备则附带 RAG/Wiki 上下文。"
    >
      <ChatPanel />
    </AppShell>
  );
}
