import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@/storage/db";
import { writeAudit } from "./audit";

export type ActivateRequest = {
  algorithm: string;
  serial_number: string;
  challenge: string;
  hmac: string;
};

export type ActivateResult =
  | { status: 200 }
  | { status: 202 }
  | { status: 400; reason: string }
  | { status: 401; reason: string }
  | { status: 404; reason: string }
  | { status: 409; reason: string }
  | { status: 410; reason: string };

function hmacKeyForSerial(serialNumber: string): Buffer | null {
  const seed = `${process.env.XIAOZHI_HMAC_SEED ?? "dev-hmac-seed"}::${serialNumber}`;
  return createHash("sha256").update(seed).digest();
}

function safeEqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export async function handleActivate(req: ActivateRequest): Promise<ActivateResult> {
  if (req.algorithm !== "hmac-sha256") {
    return { status: 400, reason: `unsupported algorithm: ${req.algorithm}` };
  }
  if (!req.serial_number || !req.challenge || !req.hmac) {
    return { status: 400, reason: "missing required fields" };
  }

  const activation = await db.activation.findFirst({
    where: { challenge: req.challenge, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  if (!activation) {
    return { status: 404, reason: "challenge not found or already consumed" };
  }
  if (activation.expiresAt && activation.expiresAt.getTime() <= Date.now()) {
    await db.activation.update({
      where: { id: activation.id },
      data: { status: "expired" },
    });
    return { status: 410, reason: "challenge expired" };
  }

  const key = hmacKeyForSerial(req.serial_number);
  if (!key) return { status: 400, reason: "key derivation failed" };

  const expectedHex = createHmac("sha256", key).update(req.challenge).digest("hex");
  if (!safeEqHex(expectedHex, req.hmac)) {
    return { status: 401, reason: "hmac mismatch" };
  }

  if (!activation.deviceId) {
    return { status: 404, reason: "activation has no associated device" };
  }
  const device = await db.device.findUnique({ where: { id: activation.deviceId } });
  if (!device) {
    return { status: 404, reason: "device not found" };
  }
  if (device.status === "active" && device.activatedAt) {
    return { status: 409, reason: "device already active" };
  }

  await db.$transaction([
    db.device.update({
      where: { id: device.id },
      data: {
        status: "active",
        activatedAt: new Date(),
        serialNumber: req.serial_number,
      },
    }),
    db.activation.update({
      where: { id: activation.id },
      data: { status: "claimed", claimedAt: new Date() },
    }),
  ]);

  await writeAudit({
    actor: "device",
    actorId: device.clientId,
    action: "activation.success",
    target: `device:${device.deviceId}`,
    payload: { serial_number: req.serial_number },
  });

  return { status: 200 };
}
