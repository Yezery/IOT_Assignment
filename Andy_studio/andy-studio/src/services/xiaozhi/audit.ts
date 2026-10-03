import { db } from "@/storage/db";

export type AuditInput = {
  actor: "user" | "device" | "system";
  actorId?: string;
  action: string;
  target?: string;
  payload?: unknown;
  ip?: string;
  userAgent?: string;
};

export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorType: input.actor,
        actorId: input.actorId ?? null,
        action: input.action,
        targetType: input.target?.split(":")[0] ?? null,
        targetId: input.target?.split(":")[1] ?? null,
        payload: (input.payload ?? null) as never,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
    console.log(`[audit] wrote ${input.action}`);
  } catch (err) {
    console.error(`[audit] failed to write ${input.action}:`, err);
  }
}
