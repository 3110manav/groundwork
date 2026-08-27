import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

/**
 * Sliding-window limiter. A public widget is inherently abusable — Origin is
 * trivially spoofed outside a browser — so this plus the monthly budget
 * ceiling, not the origin allowlist, is what actually bounds damage.
 */
export async function take(key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Date.now();
  const windowKey = `rl:${key}:${Math.floor(now / (windowSec * 1000))}`;
  const count = await redis.incr(windowKey);
  if (count === 1) await redis.expire(windowKey, windowSec * 2);
  return count <= limit;
}

/**
 * Per-tenant bucket in front of the shared platform key pool. Without this one
 * busy metered site starves every other site behind the same key.
 */
export async function takeTenantSlot(siteId: string): Promise<boolean> {
  return take(`tenant:${siteId}`, 60, 60);
}

export { redis };
