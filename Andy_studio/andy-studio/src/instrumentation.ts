/**
 * Next.js instrumentation hook.
 *
 * Boots two MQTT gateways on the Node.js runtime:
 *  - Legacy gateway (`@/lib/mqtt/client`) — keeps the original Andy_studio
 *    dashboard alive (LWT + retained `device/+/status`, chat request/reply).
 *  - xiaozhi gateway (`@/lib/xiaozhi/client`) — full-duplex JSON over
 *    `device/+/messages`. Wired in M2.
 *
 * Edge runtime is skipped via `NEXT_RUNTIME`.
 *
 * The `NEXT_PHASE` check is important: Next.js evaluates this file during
 * `next build` (phase = `phase-production-build`) but `.env.local` is
 * NOT loaded there, so any env reads would crash. We defer gateway boot
 * to actual server runtimes only.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const phase = process.env.NEXT_PHASE;
  if (phase === "phase-production-build") return;

  const [
    { ensureMqttStarted, closeMqttClient },
    { ensureXiaozhiStarted, closeXiaozhiMqtt },
    { startUdpServer, stopUdpServer },
    { ensureSettingsLoaded },
  ] = await Promise.all([
    import("@/lib/mqtt/client"),
    import("@/lib/xiaozhi/client"),
    import("@/lib/xiaozhi/udp-server"),
    import("@/services/ai/settings-store"),
  ]);

  await ensureSettingsLoaded();

  const udpPort = parseInt(process.env.XIAOZHI_UDP_PORT || "18888", 10);
  const udpHost = process.env.XIAOZHI_UDP_HOST || "0.0.0.0";

  const legacyGatewayEnabled = process.env.XIAOZHI_LEGACY_GATEWAY !== "false";

  await Promise.all([
    legacyGatewayEnabled ? ensureMqttStarted() : Promise.resolve(),
    ensureXiaozhiStarted(),
    startUdpServer(udpPort, udpHost),
  ]);

  const nodeProcess = process as NodeJS.Process;
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[instrumentation] ${signal} received, closing gateways...`);
    await Promise.all([
      closeMqttClient(),
      closeXiaozhiMqtt(),
      stopUdpServer(),
    ]);
  };

  nodeProcess.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  nodeProcess.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
}
