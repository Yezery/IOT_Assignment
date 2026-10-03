"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { AppShell } from "../_components/app-shell";

export default function LoginPage(): React.ReactElement {
  const router = useRouter();
  const [email, setEmail] = useState("admin@andy.local");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      await res.json();
      router.push("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell
      pathname="/login"
      showNav={false}
      title="登录 Andy Studio"
      description="Andy Studio 后台用于管理设备、签发激活码、查看聊天历史与审计。普通用户在没有账号前请联系管理员创建或重置密码。"
    >
      <form
        onSubmit={onSubmit}
        className="mx-auto w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <label className="mb-3 block">
          <span className="text-xs font-medium text-slate-500">邮箱</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          />
        </label>
        <label className="mb-4 block">
          <span className="text-xs font-medium text-slate-500">密码</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          />
        </label>
        {error ? (
          <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
        ) : null}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "登录中…" : "登录"}
        </button>
        <p className="mt-4 text-xs text-slate-500">
          默认账号:
          <code className="ml-1 rounded bg-slate-100 px-1 py-0.5">admin@andy.local</code> /
          <code className="ml-1 rounded bg-slate-100 px-1 py-0.5">admin123</code> (管理员),
          <code className="ml-1 rounded bg-slate-100 px-1 py-0.5">operator@andy.local</code> /
          <code className="ml-1 rounded bg-slate-100 px-1 py-0.5">operator123</code> (操作员)。
        </p>
      </form>
    </AppShell>
  );
}
