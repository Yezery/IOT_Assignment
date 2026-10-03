/**
 * MCP tool loader.
 *
 * Reads `src/config/mcp-servers.json` (or `./config/mcp-servers.json`),
 * resolves `${VAR}` placeholders against process.env, and hands the
 * connections to LangChain's MultiServerMCPClient.
 *
 * Tools whose name appears in `RESERVED` are filtered out so they don't
 * collide with built-in agent tools.
 */

import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { Connection } from "@langchain/mcp-adapters";
import { promises as fs } from "node:fs";
import path from "node:path";

const RESERVED = new Set<string>([
  // Add names of agent tools we ship ourselves to keep them out of MCP.
  // Currently empty — add here when you ship built-in tools.
]);

const resolveEnv = (v: string): string =>
  v.replace(/\$\{(\w+)\}/g, (_, k: string) => process.env[k] ?? "");

async function loadConfig(): Promise<Record<string, Connection>> {
  const candidates = [
    path.resolve(process.cwd(), "src/config/mcp-servers.json"),
    path.resolve(process.cwd(), "config/mcp-servers.json"),
  ];
  let raw = "";
  for (const p of candidates) {
    try {
      await fs.access(p);
      raw = await fs.readFile(p, "utf-8");
      break;
    } catch {
      /* try next */
    }
  }
  if (!raw) return {};

  const json = JSON.parse(raw) as {
    mcpServers?: Record<string, Connection>;
    servers?: Record<string, Connection>;
  };
  const servers = json.mcpServers ?? json.servers ?? {};
  for (const s of Object.values(servers) as Array<{ env?: Record<string, string> }>) {
    if (s.env) {
      for (const [k, v] of Object.entries(s.env)) {
        s.env[k] = resolveEnv(v);
      }
    }
  }
  return servers;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`${label} (${ms}ms)`)), ms),
    ),
  ]);
}

/**
 * Discover and load MCP tools. Returns an empty array on any failure
 * (config missing / connection error / timeout) so the agent stays
 * usable with built-in tools only.
 */
export async function createMCPTools(): Promise<unknown[]> {
  let servers: Record<string, Connection>;
  try {
    servers = await loadConfig();
  } catch (err) {
    console.warn(
      `[MCP] config parse failed, degrading: ${(err as Error).message}`,
    );
    return [];
  }
  if (Object.keys(servers).length === 0) return [];

  try {
    const client = new MultiServerMCPClient(servers);
    const tools = await withTimeout(client.getTools(), 10_000, "MCP tools timeout");
    return (tools as Array<{ name: string }>).filter((t) => !RESERVED.has(t.name));
  } catch (err) {
    console.warn(`[MCP] init failed, degrading: ${(err as Error).message}`);
    return [];
  }
}