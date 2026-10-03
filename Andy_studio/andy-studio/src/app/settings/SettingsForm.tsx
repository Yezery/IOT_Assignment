"use client";

import { useCallback, useEffect, useState } from "react";

type Toast =
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

export interface ProviderView {
  name: string;
  displayName: string;
  kind: "ollama" | "openai-compatible";
  baseUrl: string;
  model: string;
  apiKeyHint: string | null;
  supportsThinking: boolean;
}

export interface ModelSettingsView {
  temperature: number;
  thinking: boolean;
  maxTokens: number | null;
}

interface SettingsFormProps {
  initial: ModelSettingsView;
  providers: ProviderView[];
  activeName: string;
}

export default function SettingsForm({
  initial,
  providers,
  activeName,
}: SettingsFormProps): React.ReactElement {
  const [temperature, setTemperature] = useState(initial.temperature);
  const [thinking, setThinking] = useState(initial.thinking);
  const [maxTokens, setMaxTokens] = useState<number | "">(initial.maxTokens ?? "");
  const [selected, setSelected] = useState(activeName);
  const [formData, setFormData] = useState<Record<string, ProviderView>>(() =>
    Object.fromEntries(providers.map((p) => [p.name, { ...p }])),
  );
  const [modelsByProvider, setModelsByProvider] = useState<
    Record<string, { models: { name: string }[]; error?: string; loading: boolean }>
  >({});
  const [toast, setToast] = useState<Toast | null>(null);
  const [pending, setPending] = useState(false);
  // Holds the API key the user is currently typing. Cleared after a
  // successful save so the password field goes back to "leave empty to
  // keep" mode. Kept in component state (not formData) because the
  // ProviderView shape deliberately omits the secret.
  const [apiKeyDraft, setApiKeyDraft] = useState<Record<string, string>>({});

  // Re-sync local form when server props change (after a save).
  useEffect(() => {
    setFormData(Object.fromEntries(providers.map((p) => [p.name, { ...p }])));
    setSelected(activeName);
  }, [providers, activeName]);

  const active = formData[selected];

  const loadOllamaModels = useCallback(async (providerName: string) => {
    const p = formData[providerName];
    if (!p) return;
    setModelsByProvider((m) => ({
      ...m,
      [providerName]: { models: [], loading: true },
    }));
    try {
      const params = new URLSearchParams({
        baseUrl: p.baseUrl,
        kind: p.kind,
      });
      if (p.kind === "openai-compatible" && p.apiKeyHint) {
        // We don't send the plaintext hint; the server has no key either.
        // The list endpoint is unauthenticated for Ollama /api/tags.
      }
      const res = await fetch(`/api/llm/models?${params.toString()}`);
      const data = (await res.json()) as {
        models: { name: string }[];
        error?: string;
      };
      setModelsByProvider((m) => ({
        ...m,
        [providerName]: {
          models: data.models,
          loading: false,
          ...(data.error ? { error: data.error } : {}),
        },
      }));
    } catch (err) {
      setModelsByProvider((m) => ({
        ...m,
        [providerName]: {
          models: [],
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }, [formData]);

  const save = useCallback(async () => {
    setPending(true);
    setToast(null);
    try {
      const draftKey = apiKeyDraft[selected] ?? "";
      const patch = formData[selected]
        ? {
            name: selected,
            displayName: formData[selected].displayName,
            baseUrl: formData[selected].baseUrl,
            model: formData[selected].model,
            supportsThinking: formData[selected].supportsThinking,
            // Only send the key if the user actually typed something —
            // an empty string means "keep the existing key".
            ...(draftKey.length > 0 ? { apiKey: draftKey } : {}),
          }
        : undefined;
      const body = {
        settings: {
          temperature,
          thinking,
          maxTokens: maxTokens === "" ? null : Number(maxTokens),
        },
        activeProvider: selected,
        providerPatch: patch,
      };
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      // Reset the draft so the field clears after a successful save —
      // the password input now shows the "•••• (leave empty to keep)"
      // placeholder again.
      setApiKeyDraft((d) => {
        const next = { ...d };
        delete next[selected];
        return next;
      });
      setToast({ kind: "info", text: "Settings saved." });
    } catch (err) {
      setToast({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setPending(false);
    }
  }, [temperature, thinking, maxTokens, selected, formData, apiKeyDraft]);

  const updateActive = useCallback(
    (patch: Partial<ProviderView>) => {
      setFormData((f) => ({
        ...f,
        [selected]: { ...f[selected], ...patch },
      }));
    },
    [selected],
  );

  const reset = useCallback(async () => {
    if (!confirm("Reset all model settings to env defaults?")) return;
    setPending(true);
    try {
      const res = await fetch("/api/settings", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setToast({ kind: "info", text: "Reset to defaults." });
    } catch (err) {
      setToast({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setPending(false);
    }
  }, []);

  return (
    <section className="space-y-6">
      {toast ? (
        <div
          className={`rounded-md border px-4 py-2 text-sm ${
            toast.kind === "error"
              ? "border-rose-200 bg-rose-50 text-rose-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {toast.text}
        </div>
      ) : null}

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">LLM provider</h2>
        <p className="mt-1 text-xs text-slate-500">
          Pick a slot, then edit its connection details. Saved changes
          take effect on the next chat (no restart).
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {providers.map((p) => (
            <label
              key={p.name}
              className={`inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                selected === p.name
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
              }`}
            >
              <input
                type="radio"
                name="llm-provider"
                value={p.name}
                checked={selected === p.name}
                onChange={() => setSelected(p.name)}
                className="sr-only"
              />
              <span className="font-medium">{p.displayName}</span>
              <span className={`text-[10px] uppercase tracking-wide ${selected === p.name ? "text-slate-300" : "text-slate-400"}`}>
                {p.kind === "ollama" ? "ollama" : "openai"}
              </span>
            </label>
          ))}
        </div>

        {active ? (
          <div className="mt-5 space-y-4 border-t border-slate-100 pt-4">
            <Field label="Display name">
              <input
                type="text"
                value={active.displayName}
                onChange={(e) => updateActive({ displayName: e.target.value })}
                disabled={pending}
                className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:border-slate-400 focus:bg-white focus:outline-none disabled:opacity-50"
              />
            </Field>

            <Field
              label="Base URL"
              hint={
                active.kind === "ollama"
                  ? "Where Ollama listens. Default: http://localhost:11434"
                  : "OpenAI-compatible endpoint, e.g. https://api.openai.com/v1"
              }
            >
              <div className="flex w-full items-center gap-2">
                <input
                  type="text"
                  value={active.baseUrl}
                  onChange={(e) => updateActive({ baseUrl: e.target.value })}
                  disabled={pending}
                  className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm focus:border-slate-400 focus:bg-white focus:outline-none disabled:opacity-50"
                />
                {active.kind === "ollama" ? (
                  <button
                    type="button"
                    onClick={() => void loadOllamaModels(selected)}
                    disabled={pending || modelsByProvider[selected]?.loading}
                    className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:border-slate-400 disabled:opacity-50"
                  >
                    {modelsByProvider[selected]?.loading ? "Loading…" : "Fetch models"}
                  </button>
                ) : null}
              </div>
            </Field>

            <Field
              label="Model"
              hint={
                active.kind === "ollama" && modelsByProvider[selected]?.models.length
                  ? `Pick from ${modelsByProvider[selected]?.models.length} discovered models`
                  : "Type the model name, or fetch the list first"
              }
            >
              {active.kind === "ollama" &&
              (modelsByProvider[selected]?.models.length ?? 0) > 0 ? (
                <select
                  value={active.model}
                  onChange={(e) => updateActive({ model: e.target.value })}
                  disabled={pending}
                  className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:border-slate-400 focus:bg-white focus:outline-none disabled:opacity-50"
                >
                  <option value={active.model}>{active.model}</option>
                  {modelsByProvider[selected]?.models
                    .filter((m) => m.name !== active.model)
                    .map((m) => (
                      <option key={m.name} value={m.name}>{m.name}</option>
                    ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={active.model}
                  onChange={(e) => updateActive({ model: e.target.value })}
                  disabled={pending}
                  placeholder="e.g. qwen3.5:4b-mlx"
                  className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm focus:border-slate-400 focus:bg-white focus:outline-none disabled:opacity-50"
                />
              )}
              {modelsByProvider[selected]?.error ? (
                <p className="mt-1 text-xs text-rose-600">
                  {modelsByProvider[selected]?.error}
                </p>
              ) : null}
            </Field>

            <Field
              label="API key"
              hint={
                active.apiKeyHint
                  ? `Stored, ending in …${active.apiKeyHint}`
                  : active.kind === "ollama"
                    ? "Not required for Ollama"
                    : "Required for cloud provider"
              }
            >
              <input
                type="password"
                placeholder={active.apiKeyHint ? "•••• (leave empty to keep)" : "paste new key"}
                value={apiKeyDraft[selected] ?? ""}
                onChange={(e) =>
                  setApiKeyDraft((d) => ({ ...d, [selected]: e.target.value }))
                }
                disabled={pending}
                className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm focus:border-slate-400 focus:bg-white focus:outline-none disabled:opacity-50"
              />
            </Field>

            <Field label="Supports thinking" hint="Qwen3.5 / DeepSeek-R1 read this.">
              <Toggle
                checked={active.supportsThinking}
                onChange={(v) => updateActive({ supportsThinking: v })}
                disabled={pending}
                label={active.supportsThinking ? "Yes" : "No"}
              />
            </Field>
          </div>
        ) : null}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Generation parameters</h2>

        <Field
          label="Temperature"
          hint={`Sampling randomness in [0, 2]. Current: ${temperature.toFixed(2)}`}
        >
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={temperature}
            onChange={(e) => setTemperature(Number.parseFloat(e.target.value))}
            disabled={pending}
            className="w-full accent-slate-900"
          />
          <div className="mt-1 flex justify-between text-[10px] text-slate-400">
            <span>deterministic</span>
            <span>balanced</span>
            <span>creative</span>
          </div>
        </Field>

        <Field
          label="Enable thinking (CoT)"
          hint="Qwen3.5 / DeepSeek-R1 read this. Disable to skip chain-of-thought and shorten latency."
        >
          <Toggle
            checked={thinking}
            onChange={setThinking}
            disabled={pending}
            label={thinking ? "Thinking on" : "Thinking off"}
          />
        </Field>

        <Field
          label="Max tokens (optional)"
          hint="Cap completion length. Leave empty to use the model default."
        >
          <input
            type="number"
            min={1}
            max={32768}
            value={maxTokens}
            onChange={(e) => {
              const v = e.target.value;
              setMaxTokens(v === "" ? "" : Math.max(1, Number.parseInt(v, 10) || 1));
            }}
            disabled={pending}
            placeholder="e.g. 2048"
            className="w-40 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm focus:border-slate-400 focus:bg-white focus:outline-none disabled:opacity-50"
          />
          {maxTokens !== "" ? (
            <button
              type="button"
              onClick={() => setMaxTokens("")}
              className="ml-2 text-xs text-slate-500 underline-offset-2 hover:underline"
            >
              clear
            </button>
          ) : null}
        </Field>
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => void reset()}
          disabled={pending}
          className="text-xs font-medium text-slate-500 underline-offset-4 hover:text-slate-900 hover:underline disabled:opacity-40"
        >
          Reset to env defaults
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={pending}
          className="rounded-md bg-slate-900 px-5 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="border-t border-slate-100 py-4 first:border-t-0 first:pt-0">
      <label className="block text-sm font-medium text-slate-900">{label}</label>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
      <div className="mt-2 flex items-center">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
  label: string;
}): React.ReactElement {
  return (
    <label
      className={`inline-flex cursor-pointer items-center gap-2 ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      <span
        role="switch"
        aria-checked={checked}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative inline-block h-5 w-9 rounded-full transition ${
          checked ? "bg-slate-900" : "bg-slate-300"
        }`}
      >
        <span
          className={`absolute top-0.5 inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
            checked ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </span>
      <span className="text-xs text-slate-600">{label}</span>
    </label>
  );
}
