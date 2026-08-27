import Redis from "ioredis";

// No REDIS_URL means "skip rate limiting" (see .env), not "guess localhost" —
// guessing meant every request paid for a connection to a Redis that was
// never meant to be there.
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;
redis?.on("error", (err) => console.error("[ratelimit] redis error", err));

/**
 * Sliding-window limiter. A public widget is inherently abusable — Origin is
 * trivially spoofed outside a browser — so this plus the monthly budget
 * ceiling, not the origin allowlist, is what actually bounds damage.
 *
 * Fails OPEN on a Redis error: rate limiting is one defensive layer among
 * several (budget ceiling, origin allowlist), and a Redis outage should
 * degrade the site's abuse protection, not take down chat entirely.
 */
export async function take(key: string, limit: number, windowSec: number): Promise<boolean> {
  if (!redis) return true;
  const now = Date.now();
  const windowKey = `rl:${key}:${Math.floor(now / (windowSec * 1000))}`;
  try {
    const count = await redis.incr(windowKey);
    if (count === 1) await redis.expire(windowKey, windowSec * 2);
    return count <= limit;
  } catch (err) {
    console.error("[ratelimit] take failed, allowing request", err);
    return true;
  }
}

/**
 * Per-tenant bucket in front of the shared platform key pool. Without this one
 * busy metered site starves every other site behind the same key.
 */
export async function takeTenantSlot(siteId: string): Promise<boolean> {
  return take(`tenant:${siteId}`, 60, 60);
}

export { redis };
