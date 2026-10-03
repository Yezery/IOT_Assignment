import Link from "next/link";

import { AppShell } from "./app-shell";

export default function NotSignedIn(): React.ReactElement {
  return (
    <AppShell
      pathname="/login"
      showNav={false}
      title="需要登录"
      description="该页面需要登录后才能访问。普通账号请联系管理员创建或重置密码。"
    >
      <div className="flex justify-center">
        <Link
          href="/login"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700"
        >
          前往登录 →
        </Link>
      </div>
    </AppShell>
  );
}