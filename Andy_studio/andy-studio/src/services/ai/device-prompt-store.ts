/**
 * Per-device system prompt override.
 *
 * Sits on top of the global SOUL/RULES templates in `prompts.ts`. When a
 * device has an override, it replaces SOUL entirely (RULES still come
 * from the default). When no override, the default SOUL is used.
 *
 * Empty string = clear override (back to default).
 */

interface Shape {
  byDeviceId: Map<string, string>;
}

declare global {
  var __andyDevicePrompts: Shape | undefined;
}

function store(): Shape {
  if (!globalThis.__andyDevicePrompts) {
    globalThis.__andyDevicePrompts = { byDeviceId: new Map() };
  }
  return globalThis.__andyDevicePrompts;
}

export function getDeviceSystemPrompt(deviceId: string): string | undefined {
  return store().byDeviceId.get(deviceId);
}

export function setDeviceSystemPrompt(deviceId: string, prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    store().byDeviceId.delete(deviceId);
    return "";
  }
  const capped = trimmed.slice(0, 4000);
  store().byDeviceId.set(deviceId, capped);
  return capped;
}

export function clearDeviceSystemPrompt(deviceId: string): boolean {
  return store().byDeviceId.delete(deviceId);
}

export function listDevicePrompts(): Record<string, string> {
  return Object.fromEntries(store().byDeviceId.entries());
}