# M0 — xiaozhi Protocol Skeleton

> Status: ✅ verified end-to-end on 2026-09-10.
>
> Scope: only the two HTTP endpoints the firmware hits on boot — `/api/v1/internal/ota` and `/api/v1/internal/activate`. No MQTT client, no UDP, no admin UI yet.

## What landed

```
docker-compose.yml                                  # Postgres + pgvector
andy-studio/
  prisma/
    schema.prisma                                   # 11 tables + pgvector column
    migrations/
      20260910044929_init_xiaozhi/
      20260910045223_audit_actor_free/
    config.ts (prisma.config.ts)
  src/
    storage/
      db.ts                                         # Prisma 7 + PrismaPg adapter
      redis.ts                                      # ioredis singleton (unused in M0)
    services/xiaozhi/
      protocol.ts                                   # Zod schemas (hello/listen/mcp/tts/stt/...)
      tokens.ts                                     # JWT issue/verify/revoke (HS256)
      audit.ts                                      # writeAudit() helper
      ota.ts                                        # handleOtaRequest()
      activation.ts                                 # HMAC-SHA256 verify
    lib/env.ts                                      # +xiaozhi.* fields
    app/api/v1/internal/
      ota/route.ts                                  # POST + GET fallback
      activate/route.ts                             # POST
    instrumentation.ts                              # unchanged + comment about M2 wiring
```

## Verification

```bash
docker compose up -d
DATABASE_URL='postgresql://andy:andy_dev_password@localhost:5432/andy_studio?schema=public' \
  npx prisma migrate dev
DATABASE_URL='...' XIAOZHI_JWT_SECRET='32bytes' \
  XIAOZHI_OTA_BASE_URL='http://localhost:3000' \
  XIAOZHI_MQTT_BROKER='...' XIAOZHI_HMAC_SEED='...' \
  npm run dev

# 1) Fresh device hits /ota — receives mqtt+ws+activation
curl -sX POST http://localhost:3000/api/v1/internal/ota \
  -H 'Content-Type: application/json' \
  -d '{"mac_address":"aa:bb:cc:dd:ee:02","uuid":"00000000-0000-0000-0000-000000000002","chip_model_name":"esp32s3","application":{"name":"lichuang-s3","version":"1.0.0"}}'

# 2) Device signs the activation challenge and POSTs /activate
CHALLENGE=<from step 1>
SERIAL=DEADBEEFDEADBEEFDEADBEEFDEADBEEF
SEED=$XIAOZHI_HMAC_SEED
KEY=$(printf '%s::%s' "$SEED" "$SERIAL" | sha256sum | awk '{print $1}')
HMAC=$(printf '%s' "$CHALLENGE" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"$KEY" -hex | awk '{print $NF}')
curl -sX POST http://localhost:3000/api/v1/internal/activate \
  -H 'Content-Type: application/json' \
  -d "{\"algorithm\":\"hmac-sha256\",\"serial_number\":\"$SERIAL\",\"challenge\":\"$CHALLENGE\",\"hmac\":\"$HMAC\"}"
# → {"ok":true}

# 3) Re-OTA → no `activation` block (already active)
```

Observed DB state after the round-trip:

```
devices:        2 rows (1 pending_activation, 1 active with serial_number bound)
activations:    2 rows (1 pending, 1 claimed)
device_tokens:  2 rows (both 7-day TTL JWTs)
audit_logs:     3 rows (ota.request × 2, activation.success × 1)
```

## What's next (M1)

- Admin login (`/api/v1/auth/*`)
- Activation management UI (`/(dashboard)/activations`)
- Device list + detail (`/api/v1/devices`, `/(dashboard)/devices`)
- Firmware rollout (`services/xiaozhi/firmware-rollout.ts`)
- Wire xiaozhi MQTT client in `instrumentation.ts`

See `docs/xiaozhi-integration-spec.md` §12 for the full M0-M7 plan.
