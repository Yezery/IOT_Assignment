# Andy_studio × xiaozhi-esp32 集成实施 Spec

> 本文档是 `system-requirements-spec.md` 的实施映射，**所有改动都落在 `/Users/yezery/Desktop/ESP32Code/Andy_studio/andy-studio/`**。
>
> **约束**：
>
> 1. AI 引擎（`src/services/ai/**`、`src/services/rag/**`、`src/services/emotion-service.ts`、`src/services/llm-service.ts`、`src/services/{asr,tts}-service.ts`、`src/services/chat-service.ts`、`src/instrumentation.ts`、`src/lib/env.ts` 的 LLM 相关字段）**保持原样，不擅自改动**。
> 2. 对接模式可以完全替换（MQTT 客户端、Topic 结构、API 形态、持久层）。
> 3. 现有 dashboard UI（`/devices`、`/chat`、`/settings`、RAG 编辑器）可保留，但行为需要适配新协议。
> 4. 优先复用现有的 AI 调用入口（`callAgent` / `Chat`）作为对话引擎入口，不引入第二套 LLM 通道。

---

## 0. 一句话目标

把 Andy_studio 从「单设备 + 串行 LLM 聊天」升级为「**xiaozhi-esp32 兼容后端 + 5 大管理模块**」，但仍用 Andy_studio 自带的 `services/ai` 引擎做对话/MCP/RAG/情绪。固件 `xiaozhi-esp32` 只替换 `CONFIG_OTA_URL` + NVS `mqtt`/`websocket` 配置即可对接。

---

## 1. 现有 Andy_studio 复用清单

| 模块 | 路径 | 复用方式 |
|---|---|---|
| AI 对话引擎 | `src/services/ai/engine.ts` (`callAgent`/`Chat`) | **直接复用**——`xiaozhi-protocol` 把 STT/唤醒词转为 user prompt |
| 系统 prompt 合成 | `src/services/ai/prompts.ts` (`composeSystemPrompt`) | 直接复用 |
| LLM 提供器 | `src/services/ai/llm.ts` | 直接复用 |
| MCP 客户端 | `src/services/ai/mcp.ts` | 直接复用，但设备侧 `type:"mcp"` 改走 `services/xiaozhi/mcp-bridge.ts` |
| 情绪识别 | `src/services/emotion-service.ts` | 直接复用 |
| RAG（每设备） | `src/services/rag/**` | 直接复用，但绑定 `client_id` 而不是 `device_id` |
| 设备 Prompt Store | `src/services/ai/device-prompt-store.ts` | 直接复用（key = `client_id`） |
| Settings UI | `src/app/settings/**` | 直接复用（无需改） |
| Chat 沙箱 | `src/app/chat/**` | **新增**「设备选择 → 触发 `callAgent`」的开关，**不删**已有 UI |
| Next.js 16 App Router | 全局 | 保留 |

**替换/扩展清单**：

| 原模块 | 新模块 |
|---|---|
| `src/lib/mqtt/client.ts` (chat-request/reply) | `src/lib/mqtt/xiaozhi-client.ts`（订阅 `device/+/messages` + 业务派发） |
| `src/lib/device/{parse,store,chat-parse,alias-store}.ts` | 扩展为 `src/lib/xiaozhi/device-{parse,store,messages,alias}.ts`；老 `device/*` 文件保留但仅给 `/devices` 老 UI 使用 |
| `src/app/api/devices/**` | 扩展为 `/api/v1/devices/**`（按 Spec §4），保留 `/api/devices` 给老 UI |
| `src/app/api/chat/route.ts` | 保留（沙箱 UI 仍用），新增 `/api/v1/internal/xiaozhi/converse` |
| `src/services/device-service.ts` | 扩展 `xiaozhi-device-service.ts`（基于 Spec §6 的字段） |
| — | **新增** `src/services/xiaozhi/{protocol,ota,activation,firmware-rollout,mcp-bridge,commands}.ts` |
| — | **新增** `src/storage/{db,schema,migrations}/`（Postgres/Prisma） |
| — | **新增** `src/app/api/v1/**` 全部管理 API |
| — | **新增** `src/app/(dashboard)/{devices,firmware,activations,mcp,audit}/**` UI |

---

## 2. 总体架构（新增部分用框标出）

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Andy_studio (Next.js 16)                         │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  services/ai  (保留原样)                                            │ │
│  │   engine.ts / prompts.ts / llm.ts / mcp.ts / settings-store.ts     │ │
│  │   device-prompt-store.ts / emotion-service.ts / rag/*              │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                              ▲                                            │
│                              │ callAgent() / Chat.send()                  │
│                              │                                            │
│  ┌───────────────────────────┴───────────────────────────────────────┐  │
│  │  NEW · services/xiaozhi/                                          │  │
│  │   ├ protocol.ts        —— xiaozhi 协议常量与 Zod schema            │  │
│  │   ├ session-router.ts  —— hello/listen/mcp/stt/tts 路由           │  │
│  │   ├ mcp-bridge.ts      —— 设备↔agent-tools MCP JSON-RPC 桥         │  │
│  │   ├ commands.ts        —— 设备下行指令（reboot/upgrade/tts/alert） │  │
│  │   ├ ota.ts             —— 设备激活/版本/固件配置下发              │  │
│  │   ├ activation.ts      —— HMAC challenge 校验                     │  │
│  │   ├ firmware-rollout.ts —— 灰度策略                                │  │
│  │   └ converse.ts        —— 把 STT/唤醒词送进 callAgent              │  │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                              ▲                                            │
│  ┌───────────────────────────┴───────────────────────────────────────┐  │
│  │  NEW · lib/mqtt/xiaozhi-client.ts                                 │  │
│  │   订阅 device/+/messages；publish 走同一 topic                    │  │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                              ▲                                            │
│  ┌───────────────────────────┴───────────────────────────────────────┐  │
│  │  NEW · lib/udp/audio-gateway.ts  (Node dgram + aes-ctr-gcm)       │  │
│  │   收 Opus → ASR 队列；TTS → Opus → AES-CTR → UDP                  │  │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                              ▲                                            │
│  ┌───────────────────────────┴───────────────────────────────────────┐  │
│  │  NEW · storage/{db,schema,migrations,redis}                       │  │
│  │   Postgres (Prisma) 10 表 + Redis 6 类键                          │  │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  NEW · app/api/v1/**                                              │ │
│  │   auth, devices, firmware, activations, mcp, audit, metrics, ws    │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  NEW · app/(dashboard)/{devices,firmware,activations,mcp,audit}    │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 文件级变更清单（按路径排序）

### 3.1 不动（AI 引擎区）

```
src/services/ai/**
src/services/rag/**
src/services/emotion-service.ts
src/services/llm-service.ts
src/services/asr-service.ts
src/services/tts-service.ts
src/services/chat-service.ts
src/services/ai/{prompts,settings-store,device-prompt-store,llm,mcp,engine,types,index}.ts
src/instrumentation.ts (仅追加 xiaozhi-client 启动，不改逻辑)
```

### 3.2 修改（薄改，复用为主）

| 路径 | 改动 |
|---|---|
| `src/instrumentation.ts` | 启动 `xiaozhiClient.start()` + UDP 网关；保留原 `ensureMqttStarted()` 调用作为 fallback（可选） |
| `src/lib/env.ts` | **追加** `xiaozhi.*` 段：`broker`、`endpoint`、`otaUrl`、`audioUdpHost`、`audioUdpPort`、`jwtSecret` 等；不动 `mqtt.*`/`llm.*` |
| `src/services/device-service.ts` | 保留（老 UI 用）；新增 `xiaozhi-device-service.ts` |
| `src/app/api/chat/route.ts` | 不动 |
| `src/app/chat/page.tsx` | 不动 |
| `src/app/settings/**` | 不动 |
| `next.config.ts` | **追加** `serverExternalPackages: ["aes-ctr-gcm", "@prisma/client"]`；保留 `better-sqlite3` 等 |
| `.env.example` | **追加** XIAOZHI_* 段；保留 MQTT_* / LLM_* / RAG_* 段 |
| `package.json` | **追加** deps：`@prisma/client`, `prisma`, `ws`, `zod`, `aes-ctr-gcm`, `dgram`(node built-in 不需要)，`bcrypt`，`jose`(JWT)；保留所有现有 deps |

### 3.3 删除/替换（仅对接层）

| 路径 | 操作 | 说明 |
|---|---|---|
| `src/lib/mqtt/client.ts` | **保留为旧模式**，不被引用 | 老 `/devices` UI 可继续用 LWT 上线下线；新 UI 走 `xiaozhi-client` |
| `src/lib/mqtt/startup.ts` | 不动 | |
| `src/lib/device/parse.ts` | 不动 | |
| `src/lib/device/chat-parse.ts` | 不动 | |
| `src/lib/device/store.ts` | 不动 | 老 UI 仍订阅老 `device/{id}/status` |
| `src/lib/device/alias-store.ts` | **保留**（key 用 `device_id` 或 `client_id`），新代码用 `xiaozhi-device-service.alias` | |
| `src/app/api/devices/route.ts` | 保留 | 老 UI 调用 |
| `src/app/api/devices/[deviceId]/{route,alias,system-prompt,seed-test}.ts` | 保留 | |
| `src/app/api/rag/**` | 不动 | |
| `src/app/api/settings/route.ts` | 不动 | |

### 3.4 新增（按 Spec §4 §6 落地）

```
src/lib/
  ├ xiaozhi/
  │   ├ client.ts              # MQTT client（替换 chat-request 模式）
  │   ├ protocol.ts            # 常量 + Zod schema（hello/listen/tts/stt/mcp/...）
  │   ├ messages.ts            # 类型联合 + parseIncomingMessage
  │   └ command-publisher.ts   # publish 到 device/{client_id}/messages
  ├ udp/
  │   ├ audio-gateway.ts       # dgram + AES-CTR-128 Opus
  │   ├ opus-codec.ts          # @discordjs/opus 或 native opus
  │   └ sequence.ts            # 防重放窗口
  ├ auth/
  │   ├ jwt.ts                 # HS256 签发/校验
  │   ├ bcrypt.ts
  │   └ device-token.ts        # 设备短 token 校验（HMAC-或-jwt）
  ├ realtime/
  │   ├ admin-ws.ts            # 管理后台推送通道
  │   └ event-bus.ts           # Redis pub/sub wrapper
  └ audit.ts                   # 写 audit_logs 的统一入口

src/storage/
  ├ db.ts                      # PrismaClient 单例（globalThis HMR-safe）
  ├ schema.prisma              # 见 §6
  ├ migrations/
  └ redis.ts                   # ioredis 单例

src/services/
  └ xiaozhi/
      ├ device-service.ts      # CRUD / list / state（合并 Spec §6.2 字段）
      ├ device-state-machine.ts# 状态转换守卫（参考固件 device_state_machine）
      ├ session-store.ts       # 当前会话：session_id → state/turns
      ├ converse.ts            # 把 STT 文本送 callAgent，把输出拆 TTS 帧
      ├ mcp-bridge.ts          # 设备 MCP JSON-RPC ↔ Agent Tools
      ├ mcp-tools.ts           # 自建工具：device_status/reboot/upgrade_firmware/snapshot
      ├ commands.ts            # 后台 → 设备的 8 类 type
      ├ ota.ts                 # §3.1 / §3.2 业务实现
      ├ activation.ts          # HMAC-SHA256 校验
      ├ firmware-rollout.ts    # 灰度判定（immediate/percent/allowlist/denylist_excluded）
      ├ firmware-storage.ts    # 对象存储/MinIO 适配
      ├ tokens.ts              # 设备 token 签发/吊销
      ├ audit.ts               # audit_logs 写入（复用 lib/audit）
      └ metrics.ts             # Prometheus 文本生成

src/app/api/v1/
  ├ auth/
  │   ├ login/route.ts
  │   ├ logout/route.ts
  │   ├ me/route.ts
  │   └ refresh/route.ts
  ├ devices/
  │   ├ route.ts                       # GET list
  │   ├ [device_id]/
  │   │   ├ route.ts                   # GET detail
  │   │   ├ status/route.ts            # GET realtime
  │   │   ├ commands/route.ts          # POST send command
  │   │   ├ sessions/route.ts          # GET history
  │   │   ├ logs/route.ts              # GET device logs
  │   │   ├ mcp/route.ts               # POST mcp tool call (server-initiated)
  │   │   └ group/route.ts             # PUT group
  │   └ groups/route.ts                # GET/POST groups
  ├ firmware/
  │   ├ boards/route.ts                # GET
  │   ├ releases/route.ts              # GET list / POST upload
  │   ├ releases/[id]/route.ts         # GET / PATCH / DELETE
  │   ├ releases/[id]/progress/route.ts# GET realtime
  │   ├ releases/[id]/rollback/route.ts# POST
  │   └ uploads/route.ts               # POST presign
  ├ activations/
  │   ├ route.ts                       # GET list / POST create
  │   └ [id]/
  │       ├ route.ts                   # DELETE
  │       └ claim/route.ts             # POST (设备调用)
  ├ mcp/
  │   ├ tools/route.ts                 # GET merged tool list
  │   ├ tools/[name]/route.ts          # PATCH enable/default
  │   ├ prompts/route.ts               # GET/POST
  │   └ prompts/[id]/route.ts          # PATCH/DELETE
  ├ audit/
  │   ├ logs/route.ts                  # GET
  │   └ export/route.ts                # POST async
  ├ metrics/
  │   ├ system/route.ts                # GET Prometheus
  │   └ devices/route.ts               # GET JSON
  ├ health/route.ts                    # GET
  ├ ws/
  │   └ admin/route.ts                 # WS 推送
  └ internal/                          # 设备调用（device token）
      ├ ota/route.ts                   # POST Spec §3.1
      ├ activate/route.ts              # POST Spec §3.2
      ├ firmware/[id]/route.ts         # GET 二进制流
      ├ ws/route.ts                    # WS 通道（Spec §3.5）
      └ logs/route.ts                  # POST 设备日志上报

src/app/(dashboard)/               # Next.js Route Group；保留 root layout
  ├ layout.tsx                     # 侧边栏 + 顶部 nav；包含老 /devices /chat /settings 入口
  ├ devices/
  │   ├ page.tsx                   # 列表 + 远程指令
  │   ├ [device_id]/page.tsx       # 详情 + 实时状态 + 命令面板
  │   └ [device_id]/mcp/page.tsx   # 设备侧 MCP 工具调用日志
  ├ firmware/
  │   ├ page.tsx                   # release 列表
  │   ├ new/page.tsx               # 上传 + 灰度策略表单
  │   └ [id]/page.tsx              # 详情 + 进度 + 回滚
  ├ activations/
  │   ├ page.tsx                   # 列表 + 二维码
  │   └ [id]/page.tsx              # 详情
  ├ mcp/
  │   ├ page.tsx                   # 工具开关 + 默认参数
  │   └ prompts/page.tsx           # 系统提示词（global/group/device）
  └ audit/
      ├ page.tsx                   # 日志查询
      └ metrics/page.tsx           # 系统指标

src/components/
  ├ nav-sidebar.tsx                # 5 大模块导航
  ├ device-card.tsx                # 复用 + 扩展
  ├ command-dialog.tsx             # 远程指令（reboot / send tts / send alert / mcp call）
  ├ firmware-progress-bar.tsx
  ├ activation-qr-card.tsx
  └ data-table.tsx                 # TanStack Table 通用表格
```

---

## 4. 协议适配层（services/xiaozhi）

### 4.1 `services/xiaozhi/protocol.ts`（常量 + Zod）

```ts
// 文件：src/services/xiaozhi/protocol.ts
import { z } from "zod";

// 与 docs/xiaozhi-network-integration.md §2.5 §3.3 完全一致。
export const LISTEN_STATES = ["start", "stop", "detect"] as const;
export const LISTEN_MODES  = ["auto", "manual", "realtime"] as const;
export const TTS_STATES    = ["start", "stop", "sentence_start"] as const;
export const ABORT_REASONS = ["wake_word_detected"] as const;

export const IncomingMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"),  transport: z.string(), session_id: z.string().optional(), audio_params: z.any().optional(), udp: z.any().optional() }),
  z.object({ type: z.literal("listen"), session_id: z.string(), state: z.enum(LISTEN_STATES), mode: z.enum(LISTEN_MODES).optional(), text: z.string().optional() }),
  z.object({ type: z.literal("abort"),  session_id: z.string(), reason: z.string().optional() }),
  z.object({ type: z.literal("mcp"),    session_id: z.string(), payload: z.any() }),
  z.object({ type: z.literal("goodbye"), session_id: z.string() }),
  z.object({ type: z.literal("stt"),    session_id: z.string(), text: z.string() }),
  z.object({ type: z.literal("tts"),    session_id: z.string(), state: z.enum(TTS_STATES), text: z.string().optional() }),
  z.object({ type: z.literal("llm"),    session_id: z.string(), emotion: z.string(), text: z.string().optional() }),
  z.object({ type: z.literal("system"), session_id: z.string(), command: z.string() }),
  z.object({ type: z.literal("alert"),  session_id: z.string(), status: z.string(), message: z.string(), emotion: z.string() }),
  z.object({ type: z.literal("notify"), audio_url: z.string(), subtitles: z.array(z.object({ start_ms: z.number(), text: z.string() })).optional() }),
]);
```

### 4.2 `lib/xiaozhi/client.ts`（替换 chat-request 模式）

> 完全替换 `src/lib/mqtt/client.ts` 的对接模式；不再订阅 `device/+/chat/request`。

```ts
// 文件：src/lib/xiaozhi/client.ts
import mqtt from "mqtt";
import type { MqttClient } from "mqtt";
import { env } from "@/lib/env";
import { IncomingMessage } from "@/services/xiaozhi/protocol";
import { sessionRouter } from "@/services/xiaozhi/session-router";
import { redis } from "@/storage/redis";

declare global { var __xiaozhiMqtt: MqttClient | undefined; }

const MESSAGES_TOPIC = (clientId: string) => `device/${clientId}/messages`;

export async function getXiaozhiClient(): Promise<MqttClient> {
  if (globalThis.__xiaozhiMqtt) return globalThis.__xiaozhiMqtt;
  const client = mqtt.connect(env.xiaozhi.brokerUrl, {
    clientId: env.xiaozhi.clientId,
    username: env.xiaozhi.username,
    password: env.xiaozhi.password,
    reconnectPeriod: 2000,
    clean: true,
    keepalive: 240,
  });

  client.on("connect", () => {
    console.log("[XiaozhiMQTT] Connected");
    client.subscribe("device/+/messages", { qos: 1 });
  });
  client.on("error", (e) => console.error("[XiaozhiMQTT]", e));

  client.on("message", async (topic, payload) => {
    const clientId = extractClientId(topic);
    if (!clientId) return;
    let parsed: unknown;
    try { parsed = JSON.parse(payload.toString("utf8")); } catch { return; }
    const result = IncomingMessage.safeParse(parsed);
    if (!result.success) { console.warn("[XiaozhiMQTT] schema reject", result.error); return; }
    // 1) 维护 device:{clientId}:state
    await redis.hset(`device:${clientId}:state`, { last_ping: Date.now() });
    // 2) 派发
    await sessionRouter.dispatch(clientId, result.data);
  });

  globalThis.__xiaozhiMqtt = client;
  return client;
}

/** 向设备下行 publish；保留 device token 检查留给 EMQX HTTP Auth。 */
export async function publishToDevice(clientId: string, payload: object) {
  const c = await getXiaozhiClient();
  return new Promise<void>((res, rej) =>
    c.publish(MESSAGES_TOPIC(clientId), JSON.stringify(payload), { qos: 1, retain: false }, (e) => e ? rej(e) : res())
  );
}
```

### 4.3 `services/xiaozhi/session-router.ts`

把 `type:"listen"/"mcp"/"goodbye"/"stt"/"tts"..."` 路由到具体服务：

| `type` | 路由目标 |
|---|---|
| `hello` | `device-state-machine.handleHello` → 生成/校验 UDP key & nonce，下发 `hello` |
| `listen` | `converse.startSession / stopSession`（按 `state`） |
| `mcp` | `mcp-bridge.relay(clientId, payload)` |
| `goodbye` | `device-state-machine.closeSession` |
| `stt` | **触发** `converse.handleStt(clientId, text)` |
| `tts` / `llm` / `alert` | 后台 UI 实时推送（`realtime/admin-ws.ts`），不主动响应 |
| `system` | 记录审计 |
| `abort` | `converse.abortSession` |

### 4.4 `services/xiaozhi/converse.ts`（把 STT 送进 AI 引擎）

```ts
import { callAgent, Chat } from "@/services/ai";
import { detectEmotion } from "@/services/emotion-service";
import { publishToDevice } from "@/lib/xiaozhi/client";
import { getDeviceSystemPrompt } from "@/services/ai/device-prompt-store";

interface PerSessionChat { chat: Chat; abort: AbortController; }

declare global { var __xiaozhiChat: Map<string, PerSessionChat> | undefined; }

export async function startSession(clientId: string, mode: "auto"|"manual"|"realtime") {
  // 同 clientId 复用 Chat 实例
  const map = (globalThis.__xiaozhiChat ??= new Map());
  const chat = new Chat({
    devicePrompt: getDeviceSystemPrompt(clientId),
  });
  const ctrl = new AbortController();
  map.set(clientId, { chat, abort: ctrl });
  await publishToDevice(clientId, { type: "listen", state: "start", mode, session_id: clientId });
}

export async function handleStt(clientId: string, text: string) {
  const entry = globalThis.__xiaozhiChat?.get(clientId);
  if (!entry) return;

  // 1) 情绪检测 → 注入系统提示（直接复用 emotion-service）
  const emo = await detectEmotion(text);

  // 2) 调 AI 引擎
  const reply = await entry.chat.send(text, /* opts= */ { emotion: emo.label });

  // 3) TTS 切片：先 sentence_start + text，再发送 UDP Opus
  await publishToDevice(clientId, { type: "tts", state: "start", session_id: clientId });
  await publishToDevice(clientId, { type: "tts", state: "sentence_start", text: reply, session_id: clientId });
  await udpGateway.sendOpusFrames(clientId, reply);   // 走 lib/udp/audio-gateway
  await publishToDevice(clientId, { type: "tts", state: "stop", session_id: clientId });
  await publishToDevice(clientId, { type: "llm", emotion: emo.label, text: reply, session_id: clientId });
}

export function abortSession(clientId: string, reason: string) {
  const entry = globalThis.__xiaozhiChat?.get(clientId);
  entry?.abort.abort();
  globalThis.__xiaozhiChat?.delete(clientId);
  return publishToDevice(clientId, { type: "abort", session_id: clientId, reason });
}
```

**关键点**：

- `Chat` 实例 per-session 持有 history；`callAgent` 适合一次性，沙箱 UI 仍用。
- 复用 `services/ai/device-prompt-store.ts` 的 per-device SOUL（key 改为 `client_id`，但 `getDeviceSystemPrompt` 已经按字符串 key，复用零成本）。
- TTS 引擎 MVP 用浏览器/系统 TTS 太弱；先用 **`pre-recorded Ogg Opus`** 或 **`@mintplex-labs/piper-tts`**（Node 自带 TTS 库）。可后期替换为云 TTS。

### 4.5 `services/xiaozhi/mcp-bridge.ts`（设备 MCP 桥）

> 设备把云端当作 MCP server；云端用 Andy_studio 自带的 agent tools 作为实现。

```ts
import { z } from "zod";
import { mcpTools } from "./mcp-tools";         // 本地工具实现
import { audit } from "@/lib/audit";

const Request = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z.any().optional(),
});

const SERVER_INFO = { protocolVersion: "2024-11-05", capabilities: { tools: {} } };

export async function relay(clientId: string, payload: unknown) {
  const parsed = Request.safeParse(payload);
  if (!parsed.success) return;

  if (parsed.data.method === "initialize") {
    return replyOk(clientId, parsed.data.id, { ...SERVER_INFO, serverInfo: { name: "andy-studio", version: process.env.npm_package_version ?? "0" } });
  }
  if (parsed.data.method === "tools/list") {
    return replyOk(clientId, parsed.data.id, { tools: mcpTools.list() });
  }
  if (parsed.data.method === "tools/call") {
    const { name, arguments: args } = parsed.data.params as { name: string; arguments: unknown };
    try {
      const result = await mcpTools.call(clientId, name, args);
      audit({ actor: "device", actorId: clientId, action: `mcp.call.${name}`, target: name });
      return replyOk(clientId, parsed.data.id, { content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
    } catch (e: any) {
      return replyErr(clientId, parsed.data.id, -32601, e.message);
    }
  }
  // notifications/*：device → server，不回包
  if (parsed.data.method.startsWith("notifications/")) {
    audit({ actor: "device", actorId: clientId, action: parsed.data.method, target: "device" });
    return;
  }
}

async function replyOk(clientId: string, id: unknown, result: unknown) {
  const { publishToDevice } = await import("@/lib/xiaozhi/client");
  await publishToDevice(clientId, { type: "mcp", session_id: clientId, payload: { jsonrpc: "2.0", id, result } });
}
async function replyErr(clientId: string, id: unknown, code: number, message: string) {
  const { publishToDevice } = await import("@/lib/xiaozhi/client");
  await publishToDevice(clientId, { type: "mcp", session_id: clientId, payload: { jsonrpc: "2.0", id, error: { code, message } } });
}
```

### 4.6 `services/xiaozhi/mcp-tools.ts`（自建工具实现）

工具列表对应 `docs/xiaozhi-network-integration.md` §5.2/§5.3 + xiaozhi-esp32 内置：

```ts
export const mcpTools = {
  list(): Array<{name: string; description: string; inputSchema: object}> { ... },
  async call(clientId: string, name: string, args: any) {
    switch (name) {
      case "self.get_device_status":       return getDeviceStatus(clientId);
      case "self.audio_speaker.set_volume":return setVolume(clientId, args.volume);
      case "self.reboot":                  return reboot(clientId);
      case "self.upgrade_firmware":        return upgradeFirmware(clientId, args.url);
      case "self.screen.snapshot":         return uploadSnapshot(clientId, args.url, args.quality);
      case "self.screen.preview_image":    return previewImage(clientId, args.url);
      case "self.assets.set_download_url": return setAssetsUrl(clientId, args.url);
      case "self.get_system_info":         return getSystemInfo(clientId);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }
};
```

工具实现要点：

- `self.get_device_status` / `self.get_system_info` → 调 `xiaozhi-device-service.get` + `lib/device/store` 的兼容层。
- `self.audio_speaker.set_volume` → 仅在 NVS 缓存最近目标音量；实际生效靠设备收到 `type:"system"` `command:"set_volume"`（需要固件支持，先落库）。
- `self.reboot` → 直接 publish `{type:"system", command:"reboot"}`。
- `self.upgrade_firmware` → publish 同上 + `audit` 落表。
- `self.screen.snapshot` → 设备自行 upload 到 `args.url`；这里只回 ack。
- `self.screen.preview_image` → 设备自行下载到 `args.url`；这里只回 ack。

### 4.7 `services/xiaozhi/commands.ts`（后台 → 设备）

```ts
type AnyMessage =
  | { type: "system"; command: "reboot" }
  | { type: "tts";    state: "start"|"stop"|"sentence_start"; text?: string }
  | { type: "alert";  status: string; message: string; emotion: string }
  | { type: "mcp";    payload: object }
  | { type: "notify"; audio_url: string; subtitles?: Array<{start_ms: number; text: string}> };

export async function sendCommand(clientId: string, msg: AnyMessage, sessionId?: string) {
  const payload = { session_id: sessionId ?? clientId, ...msg };
  await audit({ actor: "user", action: `command.${msg.type}`, target: clientId, payload });
  await publishToDevice(clientId, payload);
}
```

---

## 5. OTA / 激活 / 固件管理

### 5.1 `services/xiaozhi/ota.ts`（设备 POST /ota 的处理）

```ts
export async function handleOtaRequest(req: OtaRequest) {
  // 1) 设备快照 → 写 devices.metadata + 找/创 device
  const device = await upsertDeviceFromOta(req);

  // 2) 决定 firmware
  const release = await firmwareRollout.pick(device);
  const firmware = release
    ? { version: release.version, url: `${env.xiaozhi.otaUrl}/api/v1/internal/firmware/${release.id}`, force: release.force ? 1 : undefined }
    : undefined;

  // 3) MQTT/WS 双发配置（spec §2.1 强约束）
  const token = await tokens.issue(device.clientId);
  const mqtt = {
    endpoint: env.xiaozhi.mqttEndpoint,            // host:port
    client_id: device.clientId,
    username: token, password: token,
    keepalive: 240,
    publish_topic: `device/${device.clientId}/messages`,
  };
  const websocket = {
    url: env.xiaozhi.wsUrl,
    token,
    version: 1,
  };

  // 4) server_time
  const server_time = { timestamp: Date.now() };

  // 5) 激活：未激活 → 下发 activation
  let activation: undefined | { code: string; challenge: string; message: string; timeout_ms: number };
  if (!device.activatedAt) {
    const act = await activation.createFor(device);
    activation = { code: act.code, challenge: act.challenge, message: act.message, timeout_ms: 30000 };
  }

  return { firmware, mqtt, websocket, server_time, activation };
}
```

### 5.2 `services/xiaozhi/activation.ts`（HMAC 校验）

```ts
import { createHmac } from "node:crypto";

export async function handleActivate(req: { serial_number: string; challenge: string; hmac: string; algorithm: string }) {
  const serial = await db.serialNumber.findUnique({ where: { value: req.serial_number } });
  if (!serial) return { status: 404 };
  if (serial.claimedByDeviceId) return { status: 409 };
  const expected = createHmac("sha256", serial.hmacKey0).update(req.challenge).digest("hex");
  if (!timingSafeEqualHex(expected, req.hmac)) return { status: 401 };
  // 标记设备激活
  await db.device.update({ where: { id: serial.deviceId }, data: { activatedAt: new Date() } });
  await audit({ actor: "device", actorId: serial.deviceId, action: "activation.success" });
  return { status: 200 };
}
```

> HMAC_KEY0 由设备 efuse 持有；服务端存的是**设备出厂时签发的派生值**（不是 efuse raw key）。本 Spec 中 `serial.hmacKey0` 假设由设备厂商在产线烧入时一并写入服务端；可走 `firmware_releases` 的 metadata 字段或独立 `serial_keys` 表。

### 5.3 `services/xiaozhi/firmware-rollout.ts`

```ts
import { createHash } from "node:crypto";

export async function pick(device: Device): Promise<Release | null> {
  const candidates = await db.firmwareRelease.findMany({
    where: { status: "published", board: device.board, variant: device.variant },
    orderBy: { createdAt: "desc" },
  });
  for (const r of candidates) {
    if (await isEligible(r, device)) return r;
  }
  return null;
}

async function isEligible(r: Release, d: Device): Promise<boolean> {
  const { strategy, percent = 0, allowlist = [], denylist = [] } = r.rollout as any;
  if (denylist.includes(d.clientId)) return false;
  switch (strategy) {
    case "immediate": return true;
    case "percentage":
      const h = parseInt(createHash("sha256").update(d.clientId).digest("hex").slice(0, 8), 16);
      return (h % 100) < percent;
    case "allowlist":
      return allowlist.includes(d.clientId);
    case "denylist_excluded":
      return true;          // 上面已过滤
  }
}
```

### 5.4 `services/xiaozhi/firmware-storage.ts`

MVP 用 **本地文件系统**（`./storage/firmware/`）+ `fs.createReadStream`。MinIO/S3 通过环境变量切换。

### 5.5 `services/xiaozhi/tokens.ts`（设备短 token）

```ts
import { sign, verify } from "jose";

export async function issue(clientId: string): Promise<string> {
  const jwt = await sign(
    { sub: clientId, scope: "device", exp: Math.floor(Date.now() / 1000) + 7 * 86400 },
    env.xiaozhi.jwtSecret, { algorithm: "HS256" }
  );
  await db.deviceToken.create({ data: { clientId, token: jwt, expiresAt: new Date(Date.now() + 7*86400_000) } });
  return jwt;
}

export async function verify(token: string): Promise<{ clientId: string } | null> { /* ... */ }
```

> 设备凭据校验既可放 Next.js 内部（设备 token 由 Next.js 签发），也可放 EMQX HTTP Auth。本 Spec 默认前者，简化部署；EMQX 直接配 `password = device_token` 直通。

---

## 6. 数据模型（Prisma schema）

文件：`src/storage/schema.prisma`（与 `system-requirements-spec.md` §6 一致）：

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

model User {
  id            String   @id @default(uuid())
  email         String   @unique
  passwordHash  String   @map("password_hash")
  role          String   @default("operator")  // admin | operator
  createdAt     DateTime @default(now()) @map("created_at")
  lastLoginAt   DateTime? @map("last_login_at")
  ownedDevices  Device[] @relation("owner")
  audits        AuditLog[]
  firmwareReleasesCreated FirmwareRelease[] @relation("createdBy")
  activationsCreated    Activation[]    @relation("createdBy")
  activationsClaimed    Activation[]    @relation("claimedBy")
  @@map("users")
}

model DeviceGroup {
  id        BigInt  @id @default(autoincrement())
  name      String
  parentId  BigInt? @map("parent_id")
  createdAt DateTime @default(now()) @map("created_at")
  devices   Device[]
  @@map("device_groups")
}

model Device {
  id            BigInt   @id @default(autoincrement())
  deviceId      String   @unique @map("device_id")     // MAC
  clientId      String   @unique @map("client_id")     // UUID
  board         String
  variant       String
  boardName     String?  @map("board_name")
  serialNumber  String?  @unique @map("serial_number")
  appVersion    String?  @map("app_version")
  status        String   @default("pending_activation") // pending_activation|active|disabled
  groupId       BigInt?  @map("group_id")
  ownerUserId   String?  @map("owner_user_id")
  activationId  BigInt?  @map("activation_id")
  lastSeenAt    DateTime? @map("last_seen_at")
  createdAt     DateTime @default(now()) @map("created_at")
  activatedAt   DateTime? @map("activated_at")
  metadata      Json?    // chip_info / partition_table / display ...
  group         DeviceGroup? @relation(fields: [groupId], references: [id])
  owner         User?       @relation("owner", fields: [ownerUserId], references: [id])
  tokens        DeviceToken[]
  upgrades      FirmwareUpgrade[]
  @@map("devices")
}

model FirmwareRelease {
  id          String   @id @default(uuid())
  board       String
  variant     String
  version     String
  storageKey  String   @map("storage_key")
  sizeBytes   BigInt   @map("size_bytes")
  sha256      String
  status      String   @default("draft")  // draft|published|paused|archived
  rollout     Json
  force       Boolean  @default(false)
  notes       String?
  createdById String?  @map("created_by")
  createdAt   DateTime @default(now()) @map("created_at")
  publishedAt DateTime? @map("published_at")
  upgrades    FirmwareUpgrade[]
  createdBy   User? @relation("createdBy", fields: [createdById], references: [id])
  @@unique([board, variant, version])
  @@map("firmware_releases")
}

model FirmwareUpgrade {
  id        BigInt   @id @default(autoincrement())
  releaseId String   @map("release_id")
  deviceId  BigInt   @map("device_id")
  state     String   @default("downloading")
  progress  Int      @default(0)
  speedBps  BigInt?  @map("speed_bps")
  startedAt DateTime @default(now()) @map("started_at")
  endedAt   DateTime? @map("ended_at")
  error     String?
  release   FirmwareRelease @relation(fields: [releaseId], references: [id])
  device    Device          @relation(fields: [deviceId], references: [id])
  @@map("firmware_upgrades")
}

model Activation {
  id          BigInt   @id @default(autoincrement())
  code        String   @unique
  deviceId    BigInt?  @map("device_id")
  status      String   @default("pending")  // pending|claimed|expired
  challenge   String
  message     String?
  createdById String?  @map("created_by")
  expiresAt   DateTime? @map("expires_at")
  claimedAt   DateTime? @map("claimed_at")
  claimedById String?  @map("claimed_by")
  createdAt   DateTime @default(now()) @map("created_at")
  createdBy   User? @relation("createdBy", fields: [createdById], references: [id])
  claimedBy   User? @relation("claimedBy", fields: [claimedById], references: [id])
  @@map("activations")
}

model DeviceToken {
  id        BigInt   @id @default(autoincrement())
  deviceId  BigInt   @map("device_id")
  token     String   @unique
  expiresAt DateTime @map("expires_at")
  createdAt DateTime @default(now()) @map("created_at")
  revokedAt DateTime? @map("revoked_at")
  device    Device   @relation(fields: [deviceId], references: [id])
  @@map("device_tokens")
}

model AuditLog {
  id        BigInt   @id @default(autoincrement())
  actorType String   @map("actor_type")  // user|device|system
  actorId   String?  @map("actor_id")
  action    String
  targetType String? @map("target_type")
  targetId   String? @map("target_id")
  payload   Json?
  ip        String?
  userAgent String?  @map("user_agent")
  createdAt DateTime @default(now()) @map("created_at")
  user      User?    @relation(fields: [actorId], references: [id])
  @@index([action])
  @@index([createdAt])
  @@map("audit_logs")
}

model McpToolConfig {
  toolName     String   @id @map("tool_name")
  enabled      Boolean  @default(true)
  defaultArgs  Json?    @map("default_args")
  updatedAt    DateTime @updatedAt @map("updated_at")
  updatedById  String?  @map("updated_by")
  @@map("mcp_tool_configs")
}

model McpPrompt {
  id        BigInt   @id @default(autoincrement())
  name      String
  scope     String   // global|group|device
  scopeId   String?  @map("scope_id")
  content   String
  updatedAt DateTime @updatedAt @map("updated_at")
  updatedById String? @map("updated_by")
  @@index([scope, scopeId])
  @@map("mcp_prompts")
}
```

---

## 7. UDP 音频网关（`lib/udp/audio-gateway.ts`）

> 设备走 MQTT 通道时音频走 UDP；本模块实现 §3.4。

```ts
import dgram from "node:dgram";
import { createCipheriv, createDecipheriv } from "node:crypto";

export class AudioGateway {
  private socket = dgram.createSocket("udp4");
  private sessions = new Map<string, { key: Buffer; nonceTemplate: Buffer; remote: { addr: string; port: number }; seq: number; remoteSeq: number }>();

  start(port: number) {
    this.socket.on("message", (buf, rinfo) => this.onPacket(buf, rinfo));
    this.socket.bind(port);
  }

  register(clientId: string, keyHex: string, nonceHex: string, remote: { addr: string; port: number }) { /* ... */ }

  sendOpus(clientId: string, opus: Buffer, timestamp: number) {
    const s = this.sessions.get(clientId)!;
    const nonce = Buffer.from(s.nonceTemplate);
    const seq = ++s.seq;
    const payloadLen = Buffer.alloc(2); payloadLen.writeUInt16BE(opus.length, 0);
    const tsBuf = Buffer.alloc(4); tsBuf.writeUInt32BE(timestamp, 0);
    const seqBuf = Buffer.alloc(4); seqBuf.writeUInt32BE(seq, 0);
    nonce.writeUInt16BE(opus.length, 2);
    nonce.writeUInt32BE(timestamp, 8);
    nonce.writeUInt32BE(seq, 12);
    // encrypt + header
    const cipher = createCipheriv("aes-128-ctr", s.key, nonce);
    const enc = Buffer.concat([cipher.update(opus), cipher.final()]);
    const header = Buffer.concat([Buffer.from([0x01, 0x00]), payloadLen, Buffer.alloc(4), tsBuf, seqBuf]);
    const packet = Buffer.concat([header, enc]);
    this.socket.send(packet, s.remote.port, s.remote.addr);
  }

  private onPacket(buf: Buffer, rinfo: dgram.RemoteInfo) {
    // 解析 → 校验 type/seq → AES-CTR 解密 → 入 ASR 队列
  }
}
```

**TTS 侧**：

- `converse.handleStt` 拿到 LLM 回复文本 → TTS 引擎生成 Ogg/Opus → 按 Opus 帧切片 → `audio-gateway.sendOpus`。
- TTS MVP：**`@mintplex-labs/piper-tts`**（离线）或 **HTTP 调用云 TTS**。可插拔接口 `TTSProvider`。

**ASR 侧**：

- 设备上传的是 16 kHz Opus 帧；解密后直接给 ASR provider。
- MVP：**HTTP 调用云 ASR**（OpenAI Whisper / 阿里云一句话识别）。可插拔 `ASRProvider`。

---

## 8. 管理后台 UI

> 复用 Next.js 16 App Router + shadcn/ui + TanStack Query + ws 实时推送。

### 8.1 导航与布局

- 新增 `src/app/(dashboard)/layout.tsx`：左侧栏 5 个模块 + 顶部 Admin/User。
- 老路由 `/devices`、`/chat`、`/settings` 仍在 root 路径，不放进新 dashboard；老用户无感。

### 8.2 关键页面

| 路径 | 关键组件 | 数据源 |
|---|---|---|
| `/(dashboard)/devices/page.tsx` | `DataTable`、`DeviceCard`、`CommandDialog` | `/api/v1/devices` + WS `device.online/offline` |
| `/(dashboard)/devices/[id]/page.tsx` | `DeviceDetail`、`MCPConsole`、`CommandDialog` | `/api/v1/devices/{id}` + WS `session.*` |
| `/(dashboard)/firmware/page.tsx` | `ReleaseTable` | `/api/v1/firmware/releases` |
| `/(dashboard)/firmware/new/page.tsx` | `ReleaseForm` (multipart) | `/api/v1/firmware/uploads` (presign) + `POST /firmware/releases` |
| `/(dashboard)/firmware/[id]/page.tsx` | `ReleaseDetail`、`RolloutEditor`、`ProgressBar`、`RollbackButton` | `/api/v1/firmware/releases/{id}` + WS `firmware.progress` |
| `/(dashboard)/activations/page.tsx` | `ActivationTable`、`ActivationQRCard` | `/api/v1/activations` |
| `/(dashboard)/activations/[id]/page.tsx` | `ActivationDetail`、`RevokeButton` | `/api/v1/activations/{id}` |
| `/(dashboard)/mcp/page.tsx` | `ToolConfigTable`、`ToolToggle` | `/api/v1/mcp/tools` |
| `/(dashboard)/mcp/prompts/page.tsx` | `PromptEditor` (scope 选择) | `/api/v1/mcp/prompts` |
| `/(dashboard)/audit/page.tsx` | `AuditTable` | `/api/v1/audit/logs` |
| `/(dashboard)/audit/metrics/page.tsx` | `MetricPanel` | `/api/v1/metrics/system` |

### 8.3 WebSocket 实时通道 `/api/v1/ws/admin`

```ts
// src/app/api/v1/ws/admin/route.ts
import { WebSocketServer } from "ws";
import { verifyJwt } from "@/lib/auth/jwt";
import { subscribeDeviceUpdates, subscribeFirmwareProgress } from "@/lib/realtime/event-bus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const upgrade = req.headers.get("upgrade");
  if (upgrade !== "websocket") return new Response("expected ws", { status: 400 });
  // 用 Node `ws` 包升级（Next.js App Router 不直接支持）
  const { socket, response } = Deno.upgradeWebSocket ? /* fallback */ null : ... // 实际走自定义 server
}
```

> Next.js 16 App Router 对原生 WS 升级支持有限。**推荐方案**：把 `app/api/v1/ws/admin/route.ts` 用 `WebSocketServer` (`ws` 包) 手写 upgrade；或者起一个独立 Node 进程（`server/ws-server.ts`）用 Next.js 的 `instrumentation.ts` 启动。

---

## 9. 鉴权 / 设备 token / 速率限制

### 9.1 Admin JWT

```ts
// src/lib/auth/jwt.ts
import { sign, verify } from "jose";
const secret = new TextEncoder().encode(env.xiaozhi.jwtSecret);
export const issueUserToken = (u: User) =>
  sign({ sub: u.id, role: u.role, scope: "user" }, secret, { algorithm: "HS256", expiresIn: "1h" });
export const verifyUserToken = async (t: string) => verify(t, secret);
```

### 9.2 设备 token

由 `services/xiaozhi/tokens.ts` 用同一个 `jwtSecret` 签发，scope=`device`；EMQX ACL 或内部端点校验。

### 9.3 路由守卫

```ts
// src/lib/auth/guard.ts
export async function requireAdmin(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const t = auth.replace(/^Bearer\s+/, "");
  try {
    const claims = await verifyUserToken(t);
    if (claims.scope !== "user") throw new Error("bad scope");
    return claims as { sub: string; role: "admin" | "operator" };
  } catch { throw new Response("unauthorized", { status: 401 }); }
}

export async function requireDevice(req: Request) {
  // 内部端点：检查 token 是否属于 deviceId
  const t = req.headers.get("authorization")?.replace(/^Bearer\s+/, "");
  const v = await tokens.verify(t);
  if (!v) throw new Response("unauthorized", { status: 401 });
  return v;
}
```

### 9.4 速率限制

用 Redis token-bucket：

```ts
// src/lib/ratelimit.ts
export async function limit(key: string, perMin: number): Promise<boolean> {
  const count = await redis.incr(`rl:${key}:${Math.floor(Date.now()/60000)}`);
  await redis.expire(`rl:${key}:${Math.floor(Date.now()/60000)}`, 60);
  return count <= perMin;
}
```

应用点：

- `/api/v1/auth/login` → 5/min/IP
- `/api/v1/internal/ota` → 60/min/device
- `/api/v1/devices/{id}/commands` → 30/min/device

---

## 10. 实时通道与 event-bus

```ts
// src/lib/realtime/event-bus.ts
import { EventEmitter } from "node:events";
import { redis } from "@/storage/redis";

export const bus = new EventEmitter();

// 业务侧 emit：
bus.emit("device.online", { clientId, ts: Date.now() });
bus.emit("firmware.progress", { releaseId, deviceId, progress, speed });
bus.emit("session.started", { clientId, sessionId });

// 订阅 → 推到 admin WS：
bus.on("device.online", (e) => adminWs.broadcast({ type: "device.online", ...e }));
```

可选：Redis pub/sub 让多 Next.js 实例也能广播。

---

## 11. 审计（`lib/audit.ts`）

```ts
export async function audit(input: {
  actor: "user" | "device" | "system";
  actorId?: string;
  action: string;
  target?: string;
  payload?: any;
  req?: Request;
}) {
  await db.auditLog.create({ data: {
    actorType: input.actor,
    actorId: input.actorId,
    action: input.action,
    targetType: input.target?.split(":")[0],
    targetId: input.target?.split(":")[1],
    payload: input.payload,
    ip: input.req?.headers.get("x-forwarded-for") ?? undefined,
    userAgent: input.req?.headers.get("user-agent") ?? undefined,
  }});
}
```

调用点（最小集）：

- `/api/v1/auth/login` / `logout`
- `/api/v1/devices` CRUD + 远程指令
- `/api/v1/firmware/releases` publish/rollback
- `/api/v1/activations` create/revoke
- `/api/v1/mcp/tools` enable 变更
- `services/xiaozhi/mcp-bridge.ts` 每次 tool call
- `services/xiaozhi/activation.ts` 激活成功

---

## 12. 实施顺序（M0-M7 沿用 `system-requirements-spec.md` §13）

| 阶段 | 任务 | 涉及本 Spec 的文件 |
|---|---|---|
| **M0 协议对齐** | 把 xiaozhi-esp32 切到本地 `CONFIG_OTA_URL=...`，抓官方流量样本；落 `protocol.ts` + `messages.ts` | §4.1 |
| **M1 OTA + 激活** | Prisma schema + 迁移；`services/xiaozhi/{ota,activation,tokens,firmware-rollout}`；`/api/v1/internal/{ota,activate}`；登录/激活码/设备列表 | §5 §6 §9 §10 |
| **M2 MQTT 网关** | `lib/xiaozhi/client.ts` + `session-router.ts` + `converse.ts`；`/api/v1/devices/[id]/commands` | §4.2-§4.4 §8 |
| **M3 UDP 音频** | `lib/udp/audio-gateway.ts` + TTS/ASR provider；接通 converse | §4.4 §7 |
| **M4 OTA 灰度/回滚** | `firmware-rollout.ts`；固件上传（multipart 或 presign）；进度上报（MCP tool call） | §5.3 §5.4 |
| **M5 MCP / 提示词** | `mcp-bridge.ts` + `mcp-tools.ts`；`/api/v1/mcp/{tools,prompts}`；UI 开关 | §4.5 §4.6 |
| **M6 审计 + 监控** | `lib/audit.ts`；`/api/v1/audit/*` + Prometheus metrics；admin WS | §8.3 §10 §11 |
| **M7 验收** | 200 设备 24h soak；验收清单全过 | 全部 |

---

## 13. 验收清单（继承 Spec §12，标注 Andy_studio 落地位置）

- [ ] **§12.1.1** 激活：M1 完成 `/(dashboard)/activations` 页签生成码 + `internal/activate` 校验 + 设备 Idle
- [ ] **§12.1.2** OTA POST 返回 mqtt+ws+server_time：`services/xiaozhi/ota.ts::handleOtaRequest`
- [ ] **§12.1.3** MQTT hello/UDP：`lib/xiaozhi/client.ts` + `lib/udp/audio-gateway.ts`
- [ ] **§12.1.4** WS：`api/v1/internal/ws` Route Handler + 同 `session-router`
- [ ] **§12.1.5** MCP 双向：`mcp-bridge.ts` + `mcp-tools.ts`
- [ ] **§12.1.6** reboot：`/api/v1/devices/[id]/commands` → `services/xiaozhi/commands.sendCommand`
- [ ] **§12.1.7** upgrade：`self.upgrade_firmware` tool + `firmware-storage.ts`
- [ ] **§12.2.1** 5 大模块 UI 全部就绪
- [ ] **§12.2.2** OTA 灰度：`firmware-rollout.ts::isEligible`
- [ ] **§12.2.3** OTA 回滚：PATCH release `{status:"archived"}` + 重新发布旧版
- [ ] **§12.2.4** 审计：所有路由调 `audit()`
- [ ] **§12.2.5** 实时：admin WS `device.online` 推送
- [ ] **§12.3.1** 固件零改动：`CONFIG_OTA_URL` 仅替换
- [ ] **§12.3.2** 向下兼容：NVS `ota_url` 覆盖生效
- [ ] **§12.4** TLS/备份/Prometheus：Docker Compose 加 nginx + pg_dump + `/api/v1/metrics/system`

---

## 14. 与原 Andy_studio 共存策略

| 共存项 | 处理 |
|---|---|
| 老 `/api/devices` + 老 `/devices` UI | **保留**，继续订阅 `device/+/status`（LWT + retained）。新 dashboard 走 `/api/v1/devices`，数据来源是 Postgres |
| 老 `/api/chat` 沙箱 | **保留**，继续调 `chatService` + `callAgent`，不依赖 `clientId` |
| 老 `services/rag/**` | **复用**：`xiaozhi-converse` 在 `devicePrompt` 处拉 `getDeviceSystemPrompt(clientId)` |
| 老 `services/ai/**` | **不动**（AI 引擎） |
| 老 `instrumentation.ts` | 启动追加 `xiaozhiClient.start()`；EMQX 老订阅不动 |
| 老 MQTT topic `device/+/chat/request` | **可下线**：M2 完成并验证后，删除老 `lib/mqtt/client.ts` 中的 chat 分支（保留 status） |

---

## 15. 风险与开放

1. **ASR/TTS 实现选型**：MVP 推荐接云 ASR/TTS（OpenAI Whisper + Cartesia/OpenAI TTS）。离线 TTS 用 Piper，CPU 重；按需启用。
2. **UDP NAT**：自托管单机房不需 STUN；多机房再评估。
3. **设备 token 校验位置**：默认放 Next.js 内部；若 EMQX 启用 HTTP Auth，可双层校验。
4. **Postgres 与 RAG 共存**：老 RAG 用 `better-sqlite3` 不受影响；新 deviceId/assetId 体系独立。
5. **Next.js WS 升级**：App Router 需要手写 upgrade 或独立进程；推荐独立进程（`server/ws.ts`）。
6. **Prisma 与 better-sqlite3 同时存在**：Prisma 服务于 `xiaozhi.*`；better-sqlite3 服务于 `rag/*`。两者无 schema 冲突。

---

## 16. 总结：Andy_studio 改造后的形态

- **保留**：所有 AI 能力（`services/ai`、`services/rag`、`emotion/llm/tts/asr-service`）、沙箱 UI、Settings、RAG 编辑器。
- **替换**：对接模式从「device/+/chat/request 串行请求」改为「device/+/messages 全双工 JSON 协议 + UDP 音频通道」。
- **新增**：5 大管理模块 + Postgres + UDP 音频网关 + 实时 WS + 审计。
- **不改**：AI 引擎实现路径；老 UI 与沙箱仍可用。

最终交付：**Andy_studio 同时是 ESP32 LLM 沙箱 + xiaozhi-esp32 完整管理后台**。
