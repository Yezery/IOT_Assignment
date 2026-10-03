# M2 — xiaozhi MQTT Gateway + Converse Pipeline

> Status: ✅ verified end-to-end on 2026-09-10.
>
> Scope: full-duplex JSON-over-MQTT pipeline. `device/<client_id>/messages` is the only topic. UDP audio deferred to M3.

## What landed

```
andy-studio/
  src/
    lib/
      xiaozhi/
        client.ts                  # MQTT 3.1.1 client, subscribes device/+/messages, publishes back
    services/xiaozhi/
      session-router.ts           # dispatch incoming JSON by `type`
      converse.ts                 # listen/stt/goodbye → start/stop/handleStt/abort
      commands.ts                 # sendCommand(): server → device (tts/llm/system/alert/mcp/notify/goodbye)
    instrumentation.ts             # wires both gateways on boot (legacy + xiaozhi)
    app/api/v1/devices/[device_id]/commands/route.ts   # POST remote command
```

Plus test infrastructure (in `.tmp-*.mjs` files at project root — temporary, deletable):
- `.tmp-broker.mjs` — minimal MQTT 3.1.1 broker for local testing
- `.tmp-device-sim.mjs` — fake xiaozhi-esp32 that runs the full message flow

## Verification (local broker + simulator)

```
$ node .tmp-broker.mjs &
$ npm run dev &
$ node .tmp-device-sim.mjs

[sim] POST http://localhost:3000/api/v1/internal/ota
[sim] got OTA response:
  endpoint: 127.0.0.1:1883
  publish_topic: device/00000000-0000-0000-0000-000000000003/messages
[sim] mqtt connected
[sim] subscribed
[sim] → hello
[sim] ← {"type":"hello","transport":"udp","version":3,...}
[sim] → listen start
[sim] ← {"type":"listen","state":"start",...}      (echoed by server)
[sim] ← {"type":"tts","state":"start",...}        (server initiated TTS)
[sim] → stt: 你好, 介绍一下你自己。
[sim] ← {"type":"tts","state":"sentence_start","text":"你好,我是 Andy..."}  ← real LLM response!
[sim] ← {"type":"tts","state":"stop"}
[sim] ← {"type":"mcp",...}
[sim] → stt: 今天有点累
[sim] ← {"type":"tts","state":"sentence_start","text":"累了就休息会儿..."}  ← emotional reply
...
```

### Observed audit trail

```
device    | ota.request          — POST /api/v1/internal/ota
device    | device.hello         — inbound `hello` from device
device    | converse.reply       — STT → callAgent → reply (650 chars)
user      | command.tts          — server → device tts/sentence_start
user      | command.mcp          — server → device mcp notification
user      | command.tts          — server → device tts/stop
```

### Remote command API

```
POST /api/v1/devices/aa:bb:cc:dd:ee:03/commands
Authorization: Bearer <admin-jwt>
{ "type": "system", "payload": { "command": "reboot" } }
→ 200 { "ok": true }   # mqtt publish to device/.../messages with type=system, command=reboot

POST /api/v1/devices/aa:bb:cc:dd:ee:03/commands
{ "type": "alert", "payload": { "status":"Warning", "message":"Battery low", "emotion":"sad" } }
→ 200 { "ok": true }   # device receives alert frame, audit logged
```

## Architecture

```
device side                                server side
─────────────                              ──────────────
xiaozhi-esp32  ──►  device/<uuid>/messages  ──►  mqtt.js client
   (publish)                                  │
                                              ├─► sessionRouter.dispatch(type)
                                              │     ├─ listen  → startListening / stopListening
                                              │     ├─ stt     → converse.handleStt → callAgent
                                              │     ├─ abort   → converse.abort
                                              │     ├─ system  → audit only
                                              │     ├─ alert   → audit only
                                              │     └─ goodbye → closeSession
                                              │
xiaozhi-esp32  ◄──  device/<uuid>/messages  ◄──  publishToDevice(type)
   (subscribe)                                  (commands.ts / converse.ts)
```

## What the agent sees

`converse.handleStt` calls:
```ts
callAgent(text, {
  emotion: emotionLabel,                  // from emotion-service.ts (mock → "neutral" in dev)
  devicePrompt,                           // from getDeviceSystemPrompt(clientId)
});
```

This is the **same** `callAgent()` the existing `/api/chat` route uses — the device-side conversation
goes through Andy_studio's existing deepagents pipeline (SOUL prompt, MCP tools, RAG, etc.).
Verified by the LLM reply that actually contains "Andy" introducing itself.

## Decisions made

| Choice | Why |
|---|---|
| MQTT 3.1.1 (not 5) | Local test broker is simpler in 3.1.1; production EMQX is fine with either. Switchable per env later. |
| QoS 0 for `publishToDevice` | The minimal test broker doesn't reliably do QoS 1 PUBACK. EMQX in production is fine — switch back to QoS 1 if needed. |
| `device/<client_id>/messages` is pub/sub on same topic | Matches xiaozhi-esp32 wire contract (xiaozhi-network-integration.md §3.3). |
| Redis call wrapped in try/catch | M2 doesn't provision Redis yet; gracefully degrades. |
| Converse state held in `globalThis.__xiaozhiSessions` Map | HMR-safe; per-clientId state; no extra persistence layer needed. |

## What's NOT here yet (intentional)

- UDP audio channel (AES-CTR Opus) — M3.
- WebSocket fallback route at `/api/v1/internal/ws` — can be added once a real device picks the WS path; the WebSocket server in firmware is optional per spec §2.1.
- Admin WS push for real-time device status — M6.
- Audio packet framing / Opus decode/encode — M3.

## Type/Lint

```
tsc --noEmit: clean
eslint: clean (1 warning about unused `reject` parameter, now fixed)
```

## Cleanup

`.tmp-broker.mjs` and `.tmp-device-sim.mjs` are dev-only. Delete them when you switch to a real broker:

```bash
rm andy-studio/.tmp-broker.mjs andy-studio/.tmp-device-sim.mjs
```

## Next milestone

**M3** — UDP audio gateway (AES-CTR-128 Opus), ASR + TTS provider stub, device → Opus → text → converse pipeline.

See `docs/xiaozhi-integration-spec.md` §12 for the full M0-M7 plan.
