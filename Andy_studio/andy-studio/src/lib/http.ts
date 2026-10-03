import { NextResponse } from "next/server";

const BIGINT_REPLACER = (_key: string, value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  return value;
};

export function json<T>(body: T, init?: ResponseInit): NextResponse {
  return new NextResponse(JSON.stringify(body, BIGINT_REPLACER), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}
