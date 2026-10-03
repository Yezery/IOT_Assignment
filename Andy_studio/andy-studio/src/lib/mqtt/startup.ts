/**
 * Node-only MQTT startup side effects.
 *
 * Splitting this out of `instrumentation.ts` keeps the static analyser
 * happy — Edge runtime never sees `process.once` and friends, while
 * Node.js still wires up MQTT + graceful shutdown.
 *
 * The AI engine (deepagents) is lazy: each `callAgent()` call constructs
 * (and caches) its own graph on first use, so we don't need any
 * eager initialization here.
 */

import { ensureMqttStarted, closeMqttClient } from "@/lib/mqtt/client";

void ensureMqttStarted();

const nodeProcess = process as NodeJS.Process;

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[instrumentation] ${signal} received, closing MQTT...`);
  await closeMqttClient();
};

nodeProcess.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
nodeProcess.once("SIGINT", () => {
  void shutdown("SIGINT");
});