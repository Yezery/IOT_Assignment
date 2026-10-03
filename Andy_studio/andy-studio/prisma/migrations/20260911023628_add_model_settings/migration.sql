-- CreateTable
CREATE TABLE "model_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "thinking" BOOLEAN NOT NULL DEFAULT false,
    "max_tokens" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_settings_pkey" PRIMARY KEY ("id")
);
