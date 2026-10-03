import { db } from "../src/storage/db";
import { hashPassword } from "../src/services/xiaozhi/password";

/**
 * Bootstrap users for the Andy Studio admin console.
 *
 * Defaults provision two accounts so a freshly-cloned project is usable out of
 * the box without anyone having to register by hand:
 *
 *   admin@andy.local   / admin123  (admin role — full control)
 *   operator@andy.local / operator123 (operator role — can bind / view devices)
 *
 * Override either account (or the passwords) via environment variables.
 */
async function ensureUser(opts: {
  email: string;
  password: string;
  role: "admin" | "operator";
}): Promise<void> {
  const existing = await db.user.findUnique({ where: { email: opts.email } });
  if (existing) {
    if (existing.role !== opts.role) {
      await db.user.update({
        where: { email: opts.email },
        data: { role: opts.role },
      });
      console.log(`[seed] updated role for ${opts.email} → ${opts.role}`);
    } else {
      console.log(`[seed] user ${opts.email} already exists (role=${opts.role})`);
    }
    return;
  }
  const passwordHash = await hashPassword(opts.password);
  await db.user.create({
    data: { email: opts.email, passwordHash, role: opts.role },
  });
  console.log(`[seed] created ${opts.email} (role=${opts.role})`);
}

async function main(): Promise<void> {
  await ensureUser({
    email: process.env.SEED_ADMIN_EMAIL ?? "admin@andy.local",
    password: process.env.SEED_ADMIN_PASSWORD ?? "admin123",
    role: "admin",
  });
  await ensureUser({
    email: process.env.SEED_OPERATOR_EMAIL ?? "operator@andy.local",
    password: process.env.SEED_OPERATOR_PASSWORD ?? "operator123",
    role: "operator",
  });
  console.log("[seed] done. Default credentials are documented in README.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exit(1);
  });
