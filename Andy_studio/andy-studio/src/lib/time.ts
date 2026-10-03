/**
 * Time helpers pinned to the device's operating timezone (Asia/Shanghai).
 *
 * Server-safe and dependency-free — uses only the built-in `Intl` API so
 * the same output is produced regardless of the host machine's local time.
 */

export const SHANGHAI_TZ = "Asia/Shanghai";

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHANGHAI_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHANGHAI_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** "YYYY-MM-DD" in Asia/Shanghai. */
export function shanghaiDay(d: Date = new Date()): string {
  return dayFormatter.format(d);
}

/** "YYYY-MM-DD HH:mm:ss" in Asia/Shanghai. */
export function formatShanghaiDateTime(d: Date = new Date()): string {
  const parts = dateTimeFormatter.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour") === "24" ? "00" : get("hour");
  const minute = get("minute");
  const second = get("second");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}
