import Link from "next/link";

/**
 * Canonical admin shell: top nav, breadcrumbs, page header, content slot.
 *
 * Goals:
 *   1. Single consistent nav across every admin page (no per-page "← back").
 *   2. Breadcrumbs show the device hierarchy for context.
 *   3. Page header is a single canonical pattern (eyebrow / title / description / actions).
 *   4. Logout lands on /login without scattering across components.
 */

import { LogoutButton } from "./logout-button";

export interface NavItem {
  href: string;
  label: string;
  description?: string;
  badge?: string;
}

export const PRIMARY_NAV: NavItem[] = [
  { href: "/", label: "首页", description: "总览入口" },
  { href: "/devices", label: "设备", description: "设备列表与状态" },
  { href: "/chat", label: "对话沙盒", description: "LLM 联调" },
  { href: "/activations", label: "激活码", description: "设备绑定" },
  { href: "/audit", label: "审计", description: "系统审计日志" },
];

export const ADMIN_NAV: NavItem[] = [
  { href: "/settings", label: "模型设置", description: "Provider / 温度 / 思考" },
  { href: "/mcp", label: "MCP", description: "工具服务" },
  { href: "/firmware", label: "固件", description: "发布与升级" },
];

export function findPrimary(pathname: string): NavItem | undefined {
  return PRIMARY_NAV.find((item) =>
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href),
  );
}

export interface AppShellProps {
  pathname: string;
  breadcrumbs?: { label: string; href?: string }[];
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  /**
   * Show the navigation chrome. Pages like `/login` opt out so the chrome
   * does not appear while signing in.
   */
  showNav?: boolean;
}

export function AppShell({
  pathname,
  breadcrumbs = [],
  title,
  description,
  eyebrow,
  actions,
  children,
  showNav = true,
}: AppShellProps): React.ReactElement {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {showNav ? (
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/80 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
            <Link
              href="/"
              className="flex items-center gap-2 text-sm font-semibold text-slate-900"
            >
              <span
                className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-slate-900 text-[10px] font-bold text-white"
                aria-hidden="true"
              >
                AS
              </span>
              Andy Studio
            </Link>
            <nav
              aria-label="主导航"
              className="hidden flex-1 items-center gap-1 md:flex"
            >
              {PRIMARY_NAV.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`rounded-md px-3 py-1.5 text-sm transition ${
                      active
                        ? "bg-slate-900 text-white"
                        : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
              <span className="mx-2 h-4 w-px bg-slate-200" aria-hidden="true" />
              {ADMIN_NAV.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`rounded-md px-3 py-1.5 text-sm transition ${
                      active
                        ? "bg-slate-900 text-white"
                        : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="ml-auto">
              <LogoutButton />
            </div>
          </div>
        </header>
      ) : null}

      <main className="mx-auto max-w-6xl px-6 py-8">
        {(breadcrumbs.length > 0 || title || description) ? (
          <div className="mb-6 border-b border-slate-200 pb-6">
            {breadcrumbs.length > 0 ? (
              <nav aria-label="面包屑" className="mb-3 flex flex-wrap items-center gap-1 text-xs text-slate-500">
                {breadcrumbs.map((crumb, idx) => {
                  const last = idx === breadcrumbs.length - 1;
                  return (
                    <span key={`${crumb.label}-${idx}`} className="flex items-center gap-1">
                      {crumb.href && !last ? (
                        <Link
                          href={crumb.href}
                          className="hover:text-slate-900 hover:underline"
                        >
                          {crumb.label}
                        </Link>
                      ) : (
                        <span className={last ? "font-medium text-slate-700" : ""}>{crumb.label}</span>
                      )}
                      {idx < breadcrumbs.length - 1 ? (
                        <span aria-hidden="true" className="text-slate-300">/</span>
                      ) : null}
                    </span>
                  );
                })}
              </nav>
            ) : null}

            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                {eyebrow ? (
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{eyebrow}</div>
                ) : null}
                <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
                {description ? (
                  <p className="mt-1 max-w-2xl text-sm text-slate-500">{description}</p>
                ) : null}
              </div>
              {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
            </div>
          </div>
        ) : null}

        {children}
      </main>
    </div>
  );
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}