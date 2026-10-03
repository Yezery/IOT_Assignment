import { SignJWT, jwtVerify } from "jose";
import { env } from "@/lib/env";
import { db } from "@/storage/db";

export type DeviceClaims = {
  sub: string;
  scope: "device";
  clientId: string;
  deviceId: string;
};

export type UserClaims = {
  sub: string;
  scope: "user";
  role: "admin" | "operator";
  email: string;
};

const ISSUER = "andy-studio-xiaozhi";
const AUDIENCE_DEVICE = "xiaozhi-device";

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.xiaozhi.jwtSecret);
}

export async function issueDeviceToken(params: {
  devicePk: bigint;
  clientId: string;
  deviceId: string;
}): Promise<string> {
  const ttlDays = env.xiaozhi.deviceTokenTtlDays;
  const expSeconds = Math.floor(Date.now() / 1000) + ttlDays * 86400;

  const jwt = await new SignJWT({
    sub: params.clientId,
    scope: "device" as const,
    clientId: params.clientId,
    deviceId: params.deviceId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE_DEVICE)
    .setIssuedAt()
    .setExpirationTime(expSeconds)
    .sign(secretKey());

  await db.deviceToken.create({
    data: {
      deviceId: params.devicePk,
      token: jwt,
      expiresAt: new Date(expSeconds * 1000),
    },
  });

  return jwt;
}

export async function verifyDeviceToken(token: string): Promise<DeviceClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE_DEVICE,
    });
    if (payload.scope !== "device") return null;
    if (typeof payload.clientId !== "string" || typeof payload.deviceId !== "string") {
      return null;
    }

    const row = await db.deviceToken.findUnique({ where: { token } });
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;

    return {
      sub: payload.sub as string,
      scope: "device",
      clientId: payload.clientId,
      deviceId: payload.deviceId,
    };
  } catch {
    return null;
  }
}

export async function revokeDeviceToken(token: string): Promise<void> {
  await db.deviceToken.updateMany({
    where: { token, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
