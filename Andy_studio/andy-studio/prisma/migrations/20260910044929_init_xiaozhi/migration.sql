-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'operator');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('pending_activation', 'active', 'disabled');

-- CreateEnum
CREATE TYPE "ActivationStatus" AS ENUM ('pending', 'claimed', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "ReleaseStatus" AS ENUM ('draft', 'published', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "UpgradeState" AS ENUM ('downloading', 'verifying', 'rebooting', 'success', 'failed');

-- CreateEnum
CREATE TYPE "PromptScope" AS ENUM ('global', 'group', 'device');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'operator',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_groups" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" BIGSERIAL NOT NULL,
    "device_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "board" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "board_name" TEXT,
    "serial_number" TEXT,
    "app_version" TEXT,
    "status" "DeviceStatus" NOT NULL DEFAULT 'pending_activation',
    "group_id" BIGINT,
    "owner_user_id" TEXT,
    "activation_id" BIGINT,
    "last_seen_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "firmware_releases" (
    "id" TEXT NOT NULL,
    "board" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" "ReleaseStatus" NOT NULL DEFAULT 'draft',
    "rollout" JSONB NOT NULL,
    "force" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "firmware_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "firmware_upgrades" (
    "id" BIGSERIAL NOT NULL,
    "release_id" TEXT NOT NULL,
    "device_id" BIGINT NOT NULL,
    "state" "UpgradeState" NOT NULL DEFAULT 'downloading',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "speed_bps" BIGINT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "firmware_upgrades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activations" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "device_id" BIGINT,
    "status" "ActivationStatus" NOT NULL DEFAULT 'pending',
    "challenge" TEXT NOT NULL,
    "message" TEXT,
    "created_by" TEXT,
    "expires_at" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "claimed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_tokens" (
    "id" BIGSERIAL NOT NULL,
    "device_id" BIGINT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "payload" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_tool_configs" (
    "tool_name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "default_args" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "mcp_tool_configs_pkey" PRIMARY KEY ("tool_name")
);

-- CreateTable
CREATE TABLE "mcp_prompts" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "PromptScope" NOT NULL,
    "scope_id" TEXT,
    "content" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "mcp_prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_embeddings" (
    "id" BIGSERIAL NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "chunk_idx" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "devices_device_id_key" ON "devices"("device_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_client_id_key" ON "devices"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_serial_number_key" ON "devices"("serial_number");

-- CreateIndex
CREATE INDEX "devices_board_variant_idx" ON "devices"("board", "variant");

-- CreateIndex
CREATE INDEX "devices_status_idx" ON "devices"("status");

-- CreateIndex
CREATE INDEX "firmware_releases_status_idx" ON "firmware_releases"("status");

-- CreateIndex
CREATE UNIQUE INDEX "firmware_releases_board_variant_version_key" ON "firmware_releases"("board", "variant", "version");

-- CreateIndex
CREATE INDEX "firmware_upgrades_device_id_idx" ON "firmware_upgrades"("device_id");

-- CreateIndex
CREATE INDEX "firmware_upgrades_release_id_idx" ON "firmware_upgrades"("release_id");

-- CreateIndex
CREATE UNIQUE INDEX "activations_code_key" ON "activations"("code");

-- CreateIndex
CREATE INDEX "activations_status_idx" ON "activations"("status");

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_token_key" ON "device_tokens"("token");

-- CreateIndex
CREATE INDEX "device_tokens_device_id_idx" ON "device_tokens"("device_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "mcp_prompts_scope_scope_id_idx" ON "mcp_prompts"("scope", "scope_id");

-- CreateIndex
CREATE INDEX "document_embeddings_scope_scope_id_idx" ON "document_embeddings"("scope", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_embeddings_scope_scope_id_doc_id_chunk_idx_key" ON "document_embeddings"("scope", "scope_id", "doc_id", "chunk_idx");

-- AddForeignKey
ALTER TABLE "device_groups" ADD CONSTRAINT "device_groups_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "device_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "device_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "firmware_releases" ADD CONSTRAINT "firmware_releases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "firmware_upgrades" ADD CONSTRAINT "firmware_upgrades_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "firmware_releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "firmware_upgrades" ADD CONSTRAINT "firmware_upgrades_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activations" ADD CONSTRAINT "activations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activations" ADD CONSTRAINT "activations_claimed_by_fkey" FOREIGN KEY ("claimed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tool_configs" ADD CONSTRAINT "mcp_tool_configs_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_prompts" ADD CONSTRAINT "mcp_prompts_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
