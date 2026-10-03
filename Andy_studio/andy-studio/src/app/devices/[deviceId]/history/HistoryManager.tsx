"use client";

import { useCallback, useEffect, useState } from "react";

type Day = { day: string; count: number };
type Message = { id: string; role: "user" | "assistant"; content: string; createdAt: string };

export default function HistoryManager({ deviceId }: { deviceId: string }): React.ReactElement {
  const [days, setDays] = useState<Day[]>([]);
  const [selectedDay, setSelectedDay] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadDay = useCallback(async (day: string) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/admin/devices/${encodeURIComponent(deviceId)}/chat-history?day=${encodeURIComponent(day)}&days=90`, { cache: "no-store" });
      const data = await res.json() as { recentDays?: Day[]; messages?: Message[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDays(data.recentDays ?? []); setSelectedDay(day); setMessages(data.messages ?? []);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  }, [deviceId]);

  const loadList = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/admin/devices/${encodeURIComponent(deviceId)}/chat-history?days=90`, { cache: "no-store" });
      const data = await res.json() as { recentDays?: Day[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const nextDays = data.recentDays ?? [];
      setDays(nextDays);
      if (nextDays[0]) await loadDay(nextDays[0].day); else { setMessages([]); setSelectedDay(""); }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setLoading(false); }
  }, [deviceId, loadDay]);

  useEffect(() => { const timer = window.setTimeout(() => void loadList(), 0); return () => window.clearTimeout(timer); }, [loadList]);

  const chooseDay = (day: string) => { void loadDay(day); };
  const removeDay = async () => {
    if (!selectedDay || !confirm(`确认永久删除 ${selectedDay} 的 ${messages.length} 条数据库聊天记录？此操作不会自动删除已生成的 Wiki 摘要。`)) return;
    setDeleting(true); setError(null);
    try {
      const res = await fetch(`/api/admin/devices/${encodeURIComponent(deviceId)}/chat-history`, {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day: selectedDay, confirm: true, reason: "admin console" }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setMessages([]); await loadList();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setDeleting(false); }
  };

  return <div className="grid gap-5 md:grid-cols-[180px_1fr]">
    <aside className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">日期</div>
      {days.length === 0 && !loading ? <p className="text-sm text-slate-500">暂无记录</p> : null}
      <div className="space-y-1">{days.map((item) => <button key={item.day} type="button" onClick={() => chooseDay(item.day)} className={`flex w-full justify-between rounded px-2 py-1.5 text-left text-sm ${selectedDay === item.day ? "bg-slate-900 text-white" : "hover:bg-slate-100"}`}><span>{item.day}</span><span className="text-xs opacity-70">{item.count}</span></button>)}</div>
    </aside>
    <section className="rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3"><div><div className="font-medium">{selectedDay || "选择日期"}</div><div className="text-xs text-slate-500">{messages.length} 条原始消息</div></div><button type="button" disabled={!selectedDay || deleting} onClick={() => void removeDay()} className="rounded border border-rose-300 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-40">{deleting ? "删除中…" : "删除当天记录"}</button></div>
      {error ? <div className="m-4 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div> : null}
      {loading ? <p className="p-4 text-sm text-slate-500">加载中…</p> : <div className="divide-y divide-slate-100">{messages.length === 0 ? <p className="p-4 text-sm text-slate-500">当天没有消息。</p> : messages.map((m) => <article key={m.id} className="p-4"><div className="mb-1 flex gap-2 text-xs text-slate-500"><span className={m.role === "user" ? "text-blue-700" : "text-emerald-700"}>{m.role === "user" ? "患者" : "Andy"}</span><time>{new Date(m.createdAt).toLocaleString()}</time></div><p className="whitespace-pre-wrap text-sm text-slate-800">{m.content}</p></article>)}</div>}
    </section>
  </div>;
}
