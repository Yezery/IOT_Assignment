# M1 — Admin Login + Device List + Activation Codes

> Status: ✅ verified end-to-end on 2026-09-10.
>
> Scope: admin auth, devices CRUD read, activation management. Mqtt commands / remote device actions land in M2.

## What landed

```
andy-studio/
  prisma/
    seed.ts                                    # creates first admin user
  src/
    lib/
      http.ts                                   # JSON helper with BigInt serialization
    services/xiaozhi/
      auth.ts                                   # JWT issue/verify + requireUser/requireAdmin
      password.ts                               # bcryptjs wrappers
    app/
      login/page.tsx                            # sign-in form (client component)
      dashboard/
        layout.tsx                              # sidebar + auth guard via cookie
        page.tsx                                # landing card grid
        devices/page.tsx                        # device table (server-rendered)
        devices/[device_id]/page.tsx            # device detail
        activations/page.tsx                    # codes + create form
        activations/CreateActivationForm.tsx   # client form
        firmware/page.tsx                       # M4 placeholder
        mcp/page.tsx                            # M5 placeholder
        audit/page.tsx                          # last-100 audit list
      api/v1/
        auth/{login,me,logout}/route.ts
        devices/route.ts                        # GET list + counts
        devices/[device_id]/route.ts            # GET detail
        devices/groups/route.ts                 # GET list + POST (admin)
        activations/route.ts                    # GET list + POST (admin)
        activations/[id]/route.ts               # DELETE (admin)
```

## Verification

```bash
DATABASE_URL='...' XIAOZHI_JWT_SECRET='32bytes' XIAOZHI_OTA_BASE_URL='http://localhost:3000' \
  XIAOZHI_MQTT_BROKER='...' XIAOZHI_HMAC_SEED='...' npm run dev

# 1) Login → JWT
TOKEN=$(curl -sX POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@andy.local","password":"admin123"}' | jq -r .token)

# 2) Devices list
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/devices

# 3) Device detail
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/devices/aa:bb:cc:dd:ee:01

# 4) Activations list
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/activations

# 5) Create activation (admin-only)
DEVICE_PK=$(psql -tA -c "SELECT id FROM devices WHERE status='pending_activation' LIMIT 1;")
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  http://localhost:3000/api/v1/activations \
  -d "{\"deviceId\":\"$DEVICE_PK\",\"expiresIn\":15}"
```

### Observed responses

```
/auth/me      → {id, email, role, lastLoginAt}
/devices      → {devices:[...], counts:{active:1,pending_activation:1,...}, page, pageSize, total}
/devices/:id  → {deviceId, clientId, status, board, appVersion, serialNumber, owner, ...}
/activations  → {activations:[{id, code, status, expiresAt, ...}]}
POST /activations → {id, code, challenge, expiresAt, message}
```

### Pages render

- `/login`              — sign-in form (200)
- `/dashboard`          — landing cards (200 with cookie, **307 → /login** without)
- `/dashboard/devices`  — table with 2 rows from M0 data
- `/dashboard/devices/aa:bb:cc:dd:ee:02` — full detail with serial + activations
- `/dashboard/activations` — table with all 4 generated codes + create form
- `/dashboard/audit`    — table with 8 entries (mix of device + user actions)
- `/dashboard/firmware` `/dashboard/mcp` — M4/M5 placeholders

## Defaults

| User | Email | Password | Role |
|---|---|---|---|
| Seeded admin | `admin@andy.local` | `admin123` | admin |

The seed reads `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_ROLE` from env. The
dashboard login page prefills the email field but password is empty.

## What still needs doing (M2 territory)

- `services/xiaozhi/commands.ts` — backend → device MQTT publish
- `lib/xiaozhi/client.ts` — MQTT gateway subscribing to `device/+/messages`
- `services/xiaozhi/session-router.ts` — dispatch incoming JSON by `type`
- `services/xiaozhi/converse.ts` — STT → callAgent → TTS pipeline
- `lib/udp/audio-gateway.ts` — AES-CTR Opus audio channel
- WebSocket fallback route at `/api/v1/internal/ws`

## AI engine — untouched

`src/services/ai/**`, `src/services/rag/**`, `services/{chat,emotion,llm,asr,tts}-service.ts`
remain on disk exactly as the upstream `andy-studio` project shipped them. All new code
lives under `services/xiaozhi/` and `app/api/v1/` / `app/dashboard/`.

See `docs/xiaozhi-integration-spec.md` §12 for the full M0-M7 plan.
