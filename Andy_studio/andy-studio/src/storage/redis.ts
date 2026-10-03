import Redis from "ioredis";

declare global {
  var __xiaozhiRedis: Redis | undefined;
}

function createRedis(): Redis {
  const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  return new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
}

export const redis: Redis = globalThis.__xiaozhiRedis ?? createRedis();
redis.on("error", () => {});

if (process.env.NODE_ENV !== "production") {
  globalThis.__xiaozhiRedis = redis;
}
