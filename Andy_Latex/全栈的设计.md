# Andy Studio

An AIoT device management dashboard for the **Andy** ESP32-S3, with a
per-device RAG knowledge base and an emotion-aware LLM conversation
engine (the **Agent Harness**).

```
ESP32-S3 ──► EMQX Cloud ──► Next.js server ──► Ollama (qwen-esconv)
   │            (MQTT)         │                        │
   │                         │                        ▼
   │                  ┌──────┴──────┐              bge-large-zh-v1.5
   │                  │  Agent      │              (RAG vector store)
   │                  │  Harness    │                    │
   │                  └──────┬──────┘                    ▼
   │                         │              per-device sqlite-vec DB
   ▼                         ▼
MQTT status / chat       REST API + dashboard UI
```

---

## Business

Andy is a single ESP32-S3 device sitting in your home. From the
operator's side you need to:

1. **See if it's online.** LWT + retained online messages tell you
   whether the device crashed or quietly rebooted.
2. **Push knowledge into it.** The device can answer questions about
   its own wiring, WiFi setup, or any topic you want — but the
   answers must come from a *device-specific* knowledge base, not a
   generic LLM. If you have two Andys (one in the kitchen, one in
   the garage), each must only see its own documents.
3. **Talk to it.** A short press on the BOOT button sends a chat
   request. The response should sound like the device's owner wrote
   it — sympathetic when the user is sad, brief when they're tired.
4. **Plug in new capabilities later** (ASR, vision, TTS, OTA, …)
   without rewriting the server.

This repo is the cloud half: a Next.js app that talks to the ESP32
over MQTT, holds a RAG knowledge base per device, and drives an LLM
agent when the user asks something.

---

## Implementation — how it got here

The project grew in five clearly separated phases. Each one is small
enough to read in a sitting and each one added exactly one capability.

### Phase 1 — device connectivity

Goal: see the device on a webpage.

- ESP32 connects to **EMQX Cloud** over MQTT/TLS, publishes
  `device/esp32-001/status` as a *retained* message on connect, and
  uses the MQTT LWT for the offline signal. So the cloud never has
  to poll the device — EMQX does the bookkeeping.
- Next.js server runs an `mqtt.js` client that subscribes to
  `device/+/status` and stores the latest snapshot in an
  in-process `Map<deviceId, DeviceStatus>`. A polling REST endpoint
  (`GET /api/devices`) lets the dashboard render the list.

### Phase 2 — chat over MQTT

Goal: tap a button, get an answer.

- ESP32 publishes `device/esp32-001/chat/request` to EMQX. Next.js
  subscribes to `device/+/chat/request`, hands the prompt to an LLM,
  and publishes the reply to `device/esp32-001/chat/reply`. The
  device's MQTT client subscribed to `/chat/reply` prints the answer
  to Serial. A parallel `POST /api/chat` lets the browser drive the
  same pipeline.
- The LLM runs through `langchain/chat_models/universal` so we can
  flip from Ollama to OpenAI just by changing env vars.

### Phase 3 — per-device RAG

Goal: answers must come from documents that belong to *that* device,
not the general model.

- We picked `sqlite-vec` for the vector store because it ships as a
  single `.dylib` and runs in-process — no Postgres to provision.
  Each device gets its own file (`data/esp32-001.db`) so the path
  itself is the tenant boundary.
- A small recursive-character splitter chunks the document, Ollama's
  `bge-large-zh-v1.5` produces a 1024-dim vector, and both go into
  one transaction. The query path is symmetric: embed the question,
  KNN over the device's vectors, join back to metadata.
- A `StructuredTool` named `retrieve_device_<id>_knowledge` is
  attached to the deepagent per request. The agent decides when to
  call it; we don't auto-inject.

### Phase 4 — emotion classification

Goal: the LLM reply should match the user's mood.

- A second small HTTP service (Ollama's `/api/embeddings` or any
  classifier endpoint) maps each prompt to a label from
  `neutral | happy | sad | angry | anxious | curious | tired`. The
  label is appended to the system prompt as a one-line instruction
  (e.g. "the user is currently sad — lead with empathy, not
  analysis").
- The classifier is swappable via `EMOTION_API_URL` + `EMOTION_API_KEY`.
  When the env is empty we use a `MockEmotionProvider` that always
  returns `neutral` so the rest of the pipeline still works offline.

### Phase 5 — Agent Harness

Goal: a single, composable place where the model, the tools, the
prompts, and the per-device personality all come together — and where
new capabilities (MCP servers, skills, a second provider, RAG over
images) can be added by dropping in a file.

The next section is the whole point of the repo.

---

## Agent Harness

The **Agent Harness** is the layer in `src/services/ai/` that turns a
user prompt into an LLM call. Everything in the AI pipeline flows
through it. Its job is intentionally small:

1. **Resolve the provider** (Ollama today, anything OpenAI-compatible).
2. **Compose the system prompt** from layers:
   SOUL → skill descriptions → tool inventory → emotion hint.
3. **Apply per-device overrides** when the request specifies a
   `deviceId`.
4. **Call the LLM** through LangChain's `ChatOpenAI` and
   `createDeepAgent` (which gives us a tool-call loop for free).
5. **Cache** the compiled graph per `(provider, level, systemPrompt)`
   so HMR doesn't re-build the graph on every request.

The file map:

```
src/services/ai/
├── engine.ts          ← getAgent, callAgent, Chat, stripThinking
├── prompts.ts         ← DEFAULT_SOUL, SYSTEM_PROMPT, composeSystemPrompt
├── llm.ts             ← BUILTIN providers (env-driven, lazy)
├── settings-store.ts  ← temperature / thinking / maxTokens (UI-tunable)
├── device-prompt-store.ts
│                      ← per-device SOUL override
├── skills/registry.ts ← add/remove skills (name + description + tools)
├── tools/registry.ts  ← agent-callable tools
├── mcp/loader.ts      ← MultiServerMCPClient bridge (@langchain/mcp-adapters)
└── mcp.ts             ← legacy module kept for back-compat
```

### System-prompt composition

The final system prompt is assembled in this order (each layer
overrides the previous one if present):

```
[1] systemPrompt (CallOpts)        ← full override
[2] devicePrompt (per-device)      ← SOUL section
[3] soul (CallOpts or env)         ← SOUL section
[4] AGENT_SOUL env                  ← SOUL section
[5] DEFAULT_SOUL (hard-coded)       ← SOUL section
                  +---\n\n---\n\n---+
[6] SYSTEM_PROMPT (hard-coded)      ← rules + work style + output rules
                  + optional:
[7] emotion hint                   ← one-liner when emotion detected
[8] RAG system hint                 ← "you have a private KB for device X"
```

Skill and tool inventories are injected between SOUL and RULES so
they read like part of the persona, not an afterthought.

### Adding a new capability

Everything is a file drop. Three examples:

- **A new tool the agent can call.** Write
  `services/ai/tools/my-tool.ts`, then in `services/ai/startup.ts`
  call `registerAgentTool({...})`. The tool description shows up
  in the system prompt automatically.
- **A new skill (knowledge + tools in one bundle).** Write
  `services/ai/skills/my-skill.ts`, call
  `registerSkill({...})` from `startup.ts`. The skill's name +
  description appear in the system prompt; its tools appear in the
  tool inventory.
- **A new LLM provider.** Append a builder to `BUILTIN_BUILDERS` in
  `services/ai/llm.ts`. The next request picks it up — no restart of
  the engine cache needed beyond process restart.

### What's intentionally not here (yet)

- A real plan→act→observe loop. The agent already calls tools when
  needed, but it doesn't yet take multi-step plans across them.
- Streaming responses to the browser. We have the pieces
  (`callAgentWithToolsStreaming`) but the chat UI uses polling.
- Persisted user-side conversation history. `Chat` keeps it in
  memory per process; restarting the server forgets it.
- Vision / audio / TTS — placeholder services exist in
  `services/{asr,tts,emotion}-service.ts` so the call sites compile,
  but the implementations are stubs.

---

## Key technical decisions

- **No Express, no Python.** Everything is Next.js 16 (App Router) +
  TypeScript + `langchain` + `deepagents` + `mqtt.js`. One process,
  one deploy.
- **Per-device SQLite, not shared Postgres + pgvector.** For a few
  devices the file-per-tenant model is simpler, faster, and
  impossible to leak across tenants. Postgres can replace it later
  without changing the call sites.
- **Tool call, not system-prompt-inject.** RAG is wired as a
  `StructuredTool`, not as a forced context block. The agent
  decides when retrieval is relevant, which saves tokens on
  trivial questions and keeps the system prompt small.
- **`emotion` is a hint, not a guard.** We append one line to the
  system prompt; we don't filter, refuse, or branch on the label.
  It's a way to nudge tone, nothing more.
- **Settings are per-process.** `settings-store.ts` and the
  per-device stores live in `globalThis` so HMR doesn't drop them.
  A real persistence layer (Postgres, Redis, disk) is a single
  swap-in — no other code needs to change.

---

## Quick start

```bash
npm install
cp .env.example .env.local       # edit MQTT creds + Ollama URL
npm run dev                      # http://localhost:3000
```

Open `/devices` to see the device list, `/chat` to talk to the
default model, `/devices/<id>/rag` to manage a device's knowledge
base, `/settings` to tune temperature / thinking / max tokens.

To switch models, edit `.env.local` and restart:

```env
LLM_BASE_URL=http://localhost:11434
LLM_MODEL=openai:qwen-esconv
```

---

## Architecture

```
ESP32-S3 ──► EMQX Cloud ──► Next.js (MQTT client) ──► in-memory store ──► REST API ──► Dashboard
   │                        │
   │                        │   ┌── device/+/status       ──► DeviceStore
   │                        │   ├── device/+/chat/request  ──► ChatService ──► Agent Harness ──► LLM
   │                        │   │                                                      │
   │                        │   │                                                      ├──► RAG (per-device)
   │                        │   │                                                      ├──► Emotion hint
   │                        │   │                                                      └──► Skills + Tools
   │                        │   └── (publishes device/+/chat/reply)
   │                        ▼
   └─ device/+/emotion (future)
```

---

## Project layout

```
src/
├── instrumentation.ts              # Next.js boot hook (skips in build phase)
├── lib/
│   ├── env.ts                      # Type-safe env access
│   ├── mqtt/
│   │   ├── client.ts               # Singleton MQTT client (globalThis) — subscribes status + chat
│   │   └── startup.ts              # Node-only side effects (MQTT, SIGTERM/SIGINT)
│   └── device/
│       ├── parse.ts                # Status payload parser
│       ├── chat-parse.ts           # Chat request payload parser
│       └── store.ts                # In-memory device map + listeners
├── services/
│   ├── device-service.ts          # Facade used by routes
│   ├── chat-service.ts             # Thin transport↔agent glue
│   ├── llm-service.ts              # LlmProvider factory + OpenAI-compatible + Mock
│   ├── emotion-service.ts          # EmotionProvider + Http/Mock — injected into LLM prompt
│   ├── ai/
│   │   ├── agent.ts                # DeepAgent-style orchestrator: emotion → prompt → LLM
│   │   ├── settings-store.ts       # Temperature / thinking / maxTokens (UI-tunable)
│   │   ├── device-prompt-store.ts  # Per-device SOUL override
│   │   ├── prompts.ts              # DEFAULT_SOUL, SYSTEM_PROMPT, composeSystemPrompt
│   │   ├── llm.ts                  # BUILTIN providers (env-driven, lazy)
│   │   ├── skills/
│   │   │   └── registry.ts         # registerSkill / listSkills / listAllSkillTools
│   │   ├── tools/
│   │   │   └── registry.ts         # Tool registry + prompt-renderer
│   │   ├── mcp/
│   │   │   └── loader.ts            # MCP client loader (Noop stub; ready for @modelcontextprotocol/sdk)
│   │   ├── mcp.ts                   # Legacy module kept for back-compat
│   │   └── startup.ts               # Idempotent skill registration on server boot
│   ├── rag/
│   │   ├── store.ts                # Per-device sqlite-vec DB lifecycle
│   │   ├── embeddings.ts            # Ollama /api/embeddings client (bge-large-zh-v1.5)
│   │   ├── chunker.ts              # Recursive-character splitter (no LangChain dep)
│   │   ├── admin.ts                 # addDocument / deleteDocument / listDocs / clearDevice
│   │   ├── retrieve.ts              # topK KNN + formatForPrompt
│   │   └── skill.ts                 # buildDeviceRetrievalTool → 注入 deepagent
│   ├── asr-service.ts              # reserved (placeholder)
│   └── tts-service.ts              # reserved (placeholder)
├── types/
│   ├── device.ts                   # Shared TS types
│   └── chat.ts                     # ChatRequest / ChatResponse / LlmProvider
└── app/
    ├── layout.tsx
    ├── page.tsx                    # Landing (links to /devices, /chat, /settings)
    ├── devices/
    │   ├── page.tsx                # Dashboard (polls /api/devices every 2s)
    │   └── [deviceId]/
    │       └── rag/
    │           ├── page.tsx        # Server component
    │           ├── RagManager.tsx  # Client: add/upload/delete docs
    │           └── SystemPromptEditor.tsx  # Client: per-device SOUL
    ├── chat/
    │   ├── page.tsx                # Chat sandbox landing
    │   └── ChatPanel.tsx           # Client: device selector + posts to /api/chat
    ├── settings/
    │   ├── page.tsx                # Global settings page
    │   └── SettingsForm.tsx         # Client form (temperature, thinking, maxTokens)
    └── api/
        ├── devices/
        │   ├── route.ts            # GET /api/devices
        │   ├── [deviceId]/
        │   │   ├── route.ts        # GET /api/devices/[deviceId]
        │   │   ├── alias/route.ts  # GET/PATCH/DELETE display name
        │   │   ├── system-prompt/route.ts  # GET/PUT/DELETE per-device SOUL
        │   │   └── seed-test/route.ts (dev-only)
        │   └── seed-test/route.ts (dev-only)
        ├── rag/
        │   └── [deviceId]/
        │       ├── route.ts        # DELETE clear
        │       ├── docs/
        │       │   ├── route.ts    # GET list / POST add (JSON) / DELETE
        │       │   └── file/route.ts  # POST upload .md/.txt
        │       └── search/route.ts  # POST raw KNN
        ├── chat/
        │   └── route.ts            # POST /api/chat
        └── settings/route.ts        # GET/PUT/DELETE /api/settings
```

---

## MQTT topic contract

| Topic pattern | Direction | Payload | Retained |
| ------------- | ---------- | ------- | -------- |
| `device/{deviceId}/status` | ESP32 → cloud | `{ "device_id": "...", "status": "online\|offline", "ip"?: "..." }` | yes (online) / LWT (offline) |
| `device/{deviceId}/chat/request` | ESP32 → cloud | `{ "prompt": "你好" }` | no |
| `device/{deviceId}/chat/reply` | cloud → ESP32 | `{ "reply": "你好！..." }` | no |

`status` must be `"online"` or `"offline"`. Anything else is logged and
discarded.

---

## REST API surface

### Devices

| Method | Path | Body | Returns |
| ------ | ---- | ---- | ------- |
| `GET`    | `/api/devices`                  | – | `{ devices: [...], counts: { total, online, offline } }` |
| `GET`    | `/api/devices/{id}`             | – | `{ deviceId, status, ip?, lastSeen, displayName? }` or 404 |
| `PATCH`  | `/api/devices/{id}/alias`       | `{ displayName }` | `{ deviceId, displayName }` |
| `DELETE` | `/api/devices/{id}/alias`       | – | `{ deviceId, cleared }` |
| `GET`    | `/api/devices/{id}/system-prompt` | – | `{ deviceId, systemPrompt }` |
| `PUT`    | `/api/devices/{id}/system-prompt` | `{ systemPrompt }` | `{ deviceId, systemPrompt }` |
| `DELETE` | `/api/devices/{id}/system-prompt` | – | `{ deviceId, cleared }` |

### Chat

| Method | Path | Body | Returns |
| ------ | ---- | ---- | ------- |
| `POST` | `/api/chat` | `{ prompt, device_id? }` | `{ reply, duration_ms, emotion, provider }` |

200 OK on success. 400 on invalid JSON / missing `prompt`. 500 on LLM
hard failure. 504 when the LLM exceeds `LLM_TIMEOUT_MS`.

### RAG (per device)

| Method | Path | Body | Returns |
| ------ | ---- | ---- | ------- |
| `GET`    | `/api/rag/{id}/docs`              | – | `{ deviceId, docs: [{ docId, chunkCount, createdAt, lastChunkAt, sampleMetadata }] }` |
| `POST`   | `/api/rag/{id}/docs`              | `{ docId, text, metadata? }` | `{ deviceId, docId, chunkIds }` |
| `POST`   | `/api/rag/{id}/docs/file`         | `multipart: file=@path` (`.md`/`.txt`/`.markdown`, ≤ 1 MiB) | `{ deviceId, docId, filename, sizeBytes, chunkIds }` |
| `DELETE` | `/api/rag/{id}/docs?docId=...`    | – | `{ deviceId, docId, removed }` |
| `DELETE` | `/api/rag/{id}`                   | – | `{ deviceId, removed }` |
| `POST`   | `/api/rag/{id}/search`            | `{ query, topK? }` | `{ deviceId, query, topK, chunks: [...], formatted? }` |

### Settings

| Method | Path | Body | Returns |
| ------ | ---- | ---- | ------- |
| `GET`    | `/api/settings` | – | `{ settings, provider }` |
| `PUT`    | `/api/settings` | `{ temperature?, thinking?, maxTokens? }` | `{ settings }` |
| `DELETE` | `/api/settings` | – | `{ settings }` |

---

## Environment variables

All env reads go through `src/lib/env.ts` (MQTT broker/credentials) or
`services/ai/llm.ts` / `settings-store.ts` (LLM). See `.env.example`
for the full list.

### MQTT

| Variable | Required | Default | Notes |
| -------- | -------- | ------- | ----- |
| `MQTT_BROKER` | yes | – | Hostname only (no protocol / port) |
| `MQTT_PORT` | no | `8883` | TLS port |
| `MQTT_USERNAME` | yes | – | EMQX Cloud username |
| `MQTT_PASSWORD` | yes | – | EMQX Cloud password (never committed) |
| `MQTT_CLIENT_ID` | no | auto-generated | Optional override |
| `MQTT_TOPIC_STATUS` | no | `device/+/status` | Status topic pattern |
| `MQTT_TOPIC_CHAT_REQUEST` | no | `device/+/chat/request` | Chat request topic pattern |
| `MQTT_REJECT_UNAUTHORIZED` | no | `false` | Set `true` once you trust the CA chain |

### LLM

| Variable | Required | Default | Notes |
| -------- | -------- | ------- | ----- |
| `LLM_API_KEY` | no | `ollama` | OpenAI-compatible bearer token. Empty = Mock provider |
| `LLM_BASE_URL` | no | `http://localhost:11434` | Any OpenAI-compatible endpoint. `LLM_BASE_URL` is the **host root** — the engine appends `/v1` itself. Do NOT include `/v1` or you'll get `404 page not found` from Ollama. |
| `LLM_MODEL` | no | `openai:qwen-esconv` | Model name to send. `openai:` prefix is stripped. |
| `LLM_TEMPERATURE` | no | `0.7` | `0..2` |
| `LLM_MAX_TOKENS` | no | – | Cap on completion tokens. Unset = model default. |
| `LLM_THINKING_NORMAL` | no | (built-in) | JSON `model_kwargs` payload when thinking is off |
| `LLM_THINKING_DEEP` | no | (built-in) | JSON `model_kwargs` payload when thinking is on (used for Qwen3.5 / DeepSeek-R1) |

The active provider is the single Ollama entry; switch by editing
`LLM_BASE_URL` / `LLM_MODEL` and restarting. To add a new provider,
append a builder to `BUILTIN_BUILDERS` in `services/ai/llm.ts`.

### Emotion (text classifier injected into LLM prompt)

| Variable | Required | Default | Notes |
| -------- | -------- | ------- | ----- |
| `EMOTION_API_KEY` | no | empty → **Mock provider (neutral)** | Bearer token for the classifier endpoint |
| `EMOTION_API_URL` | no | – | POST `{text}` → `{label, confidence}`. Labels: `neutral\|happy\|sad\|angry\|anxious\|curious\|tired\|unknown` |
| `EMOTION_TIMEOUT_MS` | no | `5000` | Per-request timeout |

### RAG (per-device knowledge base)

| Variable | Required | Default | Notes |
| -------- | -------- | ------- | ----- |
| `RAG_DATA_DIR` | no | `./data` | Where the per-device SQLite files live |
| `EMBEDDING_MODEL` | no | `bge-large-zh-v1.5` | Must already be pulled into Ollama |
| `EMBEDDING_TIMEOUT_MS` | no | `30000` | Per-request timeout |

### Deep-agent runtime

| Variable | Required | Default | Notes |
| -------- | -------- | ------- | ----- |
| `AGENT_ROOT_DIR` | no | `./work_dir` | Filesystem backend root for deepagents |
| `AGENT_SKILLS_DIR` | no | `./skills` | Skills directory loaded by deepagents |

`.env.local` is in `.gitignore`. Only `.env.example` is tracked.

---

## Dashboard pages

- **`/`** — Landing with three entry cards (devices / chat / settings).
- **`/devices`** — Live device list. Polls every 2 s. Each card
  shows online/offline status, last-seen timestamp, IP, and a "Manage
  KB" button. Click the device name to rename it (alias only, the
  physical `deviceId` is immutable).
- **`/chat`** — Sandbox. Pick a device from the dropdown to enable
  RAG for that device's KB; leave it on "— No device (LLM only) —"
  to chat without retrieval. Submit with the button or
  `⌘/Ctrl + Enter`.
- **`/devices/{id}/rag`** — RAG admin for one device. Add text,
  upload `.md`/`.txt` files, delete documents, clear everything.
  Edit the per-device SOUL override (top-of-page editor,
  debounced autosave).
- **`/settings`** — Global LLM settings: temperature slider,
  thinking toggle, max-tokens. The active provider + model are
  read-only here — switch via `.env.local`.

---

## Testing the pipeline without the ESP32

You can simulate the device with `mosquitto_pub` (install via
Homebrew: `brew install mosquitto`).

### 1. Boot the dashboard

```bash
npm run dev
```

Watch the terminal for:

```
[MQTT] Connected
[MQTT] Subscribed: device/+/status
[MQTT] Subscribed: device/+/chat/request
```

### 2. Publish an `online` status (retained)

```bash
mosquitto_pub \
  -h ie0e7e23.ala.cn-shenzhen.emqxsl.cn \
  -p 8883 \
  --cafile /etc/ssl/cert.pem \
  -u "$MQTT_USERNAME" -P "$MQTT_PASSWORD" \
  -t device/esp32-001/status \
  -m '{"device_id":"esp32-001","status":"online","ip":"192.168.1.123"}' \
  -r
```

Open <http://localhost:3000/devices> — you should see **Andy ·
Online · 192.168.1.123**.

### 3. Simulate a power-off (LWT)

```bash
mosquitto_pub \
  -h ie0e7e23.ala.cn-shenzhen.emqxsl.cn -p 8883 --cafile /etc/ssl/cert.pem \
  -u "$MQTT_USERNAME" -P "$MQTT_PASSWORD" \
  -t device/esp32-001/status \
  -m '{"device_id":"esp32-001","status":"offline"}' \
  -r
```

Within ~2 s the dashboard flips to **Offline**.

### 4. Power the device back on

Re-run step 2 — the badge returns to green within ~2 s.

### 5. Crash the broker

Stop your local tunnel or disconnect from the network. The server log
shows:

```
[MQTT] Connection closed
[MQTT] Reconnecting...
```

The dashboard keeps rendering (it just keeps polling). When
connectivity is restored the client reconnects automatically and the
retained `online` message arrives again.

---

## Local-only smoke test (no EMQX account)

If you want to verify the wiring without touching EMQX, run a local
broker:

```bash
docker run --rm -p 1883:1883 -p 9001:9001 eclipse-mosquitto:2
```

Then point `.env.local` at `localhost:1883` and tweak the MQTT code
to skip TLS (set `MQTT_REJECT_UNAUTHORIZED=true` and bypass the
`mqtts://` scheme). For production, always use the EMQX TLS endpoint.

---

## What is *not* in this version

The project deliberately leaves the following as placeholders so the
layout matches the spec without pretending they work:

- ASR / TTS / emotion services (`src/services/{asr,tts,emotion}-service.ts`)
- `src/app/api/audio`, `src/app/api/vision`, `src/app/api/ai`
- Persistence (currently a `Map`)
- WebSocket / SSE live updates (the UI polls every 2 s)
- Auth, OTA, command publish path

Each can be added incrementally without re-architecting.

---

## Troubleshooting

### "Cannot find module as expression is too dynamic"

Turbopack in Next.js 16 doesn't follow the polyfilled `require.resolve`
used by `sqlite-vec`'s default loader. The fix is hard-coded in
`services/rag/store.ts`: it walks up from `process.cwd()` to find
`node_modules/sqlite-vec-<platform>-<arch>/vec0.<ext>`. If the
binary ever moves, update the search anchors there.

### "A LIMIT or 'k = ?' constraint is required on vec0 knn queries"

`sqlite-vec` enforces that KNN queries have either a literal
`LIMIT N` clause or `AND k = ?` in the `WHERE`. The query in
`services/rag/retrieve.ts` uses the latter. Don't switch to
`LIMIT ?` (a parameter) — `sqlite-vec` checks at prepare time.

### "404 page not found" from Ollama

`LLM_BASE_URL` must be the **host root**, not the API root. The
engine appends `/v1` itself. `http://localhost:11434` works;
`http://localhost:11434/v1` causes `/v1/v1/...` and 404s.

### Build fails: "MQTT_BROKER is not set" during `npm run build`

Next.js evaluates the instrumentation hook during build too. The fix
in `src/instrumentation.ts` short-circuits when
`process.env.NEXT_PHASE === "phase-production-build"`. Make sure
you don't accidentally delete that guard.

### Geist Mono font warning at boot

`next/font/google` tries to download Geist Mono at build time and
fails behind some firewalls. We use system mono fonts instead —
`src/app/layout.tsx` does NOT import `next/font/google`, and
`globals.css` declares the system font stack directly. No external
download is needed.

---

## License

Private.
