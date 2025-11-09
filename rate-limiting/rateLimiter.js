/**
 * Global-only rate limiter.
 * Uses Redis (or Upstash) if provided, else falls back to in-memory (dev only).
 */
export function createRateLimiter({
  redis = null,
  windowSeconds = 60,
  maxRequests = 30, // global limit per window
  maxGlobal = null, // optional override for clarity
  prefix = 'rl:chat:v1:',
} = {}) {
  // in-memory fallback (dev only)
  const memory = new Map();

  const limit = Number.isFinite(maxGlobal) ? Number(maxGlobal) : Number(maxRequests);
  const key = `${prefix}GLOBAL`;

  return async function rateLimiter(req, res, next) {
    // Redis/Upstash path
    if (redis) {
      try {
        const count = await redis.incr(key);
        if (count === 1) {
          await redis.expire(key, windowSeconds);
        }
        if (count > limit) {
          const ttl = await redis.ttl(key);
          return res.status(429).json({
            success: false,
            error: 'Rate limit exceeded. Please try again later.',
            retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
            limitType: 'global',
          });
        }
        return next();
      } catch (err) {
        console.warn('[rateLimiter] redis failed, falling back to in-memory', err?.message || err);
        // fall through
      }
    }

    // In-memory fallback
    const now = Date.now();
    let bucket = memory.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 1, resetAt: now + windowSeconds * 1000 };
      memory.set(key, bucket);
      return next();
    }
    if (bucket.count >= limit) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Pleasee try again later.',
        retryAfterSeconds: retryAfter,
        limitType: 'global',
      });
    }
    bucket.count += 1;
    return next();
  };
}

