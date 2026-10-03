"use client";

import { useState } from "react";

export function LogoutButton(): React.ReactElement {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        setPending(true);
        fetch("/api/v1/auth/logout", { method: "POST" })
          .then(() => {
            if (typeof window !== "undefined") window.location.href = "/login";
          })
          .catch(() => {
            if (typeof window !== "undefined") window.location.href = "/login";
          });
      }}
      className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-100 disabled:opacity-50"
    >
      {pending ? "正在退出…" : "退出登录"}
    </button>
  );
}