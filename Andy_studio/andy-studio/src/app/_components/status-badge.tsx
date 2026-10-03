/**
 * Shared UI primitives so every admin page renders the same chip, button,
 * panel, and table styles. Components here are server-friendly and do not
 * depend on client context.
 */
import "react";

const BADGE_BASE =
  "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1";

const BADGE_TONE: Record<string, string> = {
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warning: "bg-amber-50 text-amber-700 ring-amber-200",
  danger: "bg-rose-50 text-rose-700 ring-rose-200",
  neutral: "bg-slate-100 text-slate-600 ring-slate-200",
  info: "bg-indigo-50 text-indigo-700 ring-indigo-200",
};

export function StatusBadge({
  tone = "neutral",
  children,
}: {
  tone?: keyof typeof BADGE_TONE | string;
  children: React.ReactNode;
}): React.ReactElement {
  const cls = BADGE_TONE[tone] ?? BADGE_TONE.neutral;
  return (
    <span className={`${BADGE_BASE} ${cls}`}>{children}</span>
  );
}

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { type?: "button" | "submit" | "reset" };

export function PrimaryButton({ className = "", ...rest }: ButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      {...rest}
      className={`${BUTTON_BASE} bg-slate-900 text-white hover:bg-slate-700 ${className}`}
    />
  );
}

export function SecondaryButton({ className = "", ...rest }: ButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      {...rest}
      className={`${BUTTON_BASE} border border-slate-300 bg-white text-slate-900 hover:border-slate-400 hover:bg-slate-100 ${className}`}
    />
  );
}

export function DangerButton({ className = "", ...rest }: ButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      {...rest}
      className={`${BUTTON_BASE} border border-rose-300 bg-white text-rose-700 hover:bg-rose-50 ${className}`}
    />
  );
}

export function Panel({
  title,
  description,
  actions,
  className = "",
  children,
}: {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      {title || actions ? (
        <header className="flex items-end justify-between gap-3 border-b border-slate-100 px-5 py-3">
          <div>
            {title ? <h3 className="text-sm font-semibold text-slate-900">{title}</h3> : null}
            {description ? <p className="mt-0.5 text-xs text-slate-500">{description}</p> : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "ok" | "bad";
}): React.ReactElement {
  const toneCls = tone === "ok" ? "text-emerald-600" : tone === "bad" ? "text-rose-600" : "text-slate-900";
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneCls}`}>{value}</div>
    </div>
  );
}

export function Toast({
  kind,
  children,
}: {
  kind: "info" | "error";
  children: React.ReactNode;
}): React.ReactElement {
  const cls =
    kind === "error"
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : "border-emerald-200 bg-emerald-50 text-emerald-700";
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</div>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}): React.ReactElement {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      {description ? <p className="mt-2 text-sm text-slate-500">{description}</p> : null}
    </div>
  );
}