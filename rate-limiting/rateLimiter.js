/**
 * Use Redis if provided, otherwise falls back to in-memory (for dev).
 *
 * key order:
 * 1. x-session-id header
 * 2. req.body.sessionId
 * 3. req.ip
 */
export function createRateLimiter({
  redis = null,
  windowSeconds = 60,
  maxRequests = 30,
  prefix = 'rl:chat:v1:',
} = {}) {
  // in-memory fallback (dev only)
  const memory = new Map();

  return async function rateLimiter(req, res, next) {
    // derive key from session or IP
    const sessionHeader = typeof req.headers['x-session-id'] === 'string'
      ? req.headers['x-session-id']
      : null;
    const sessionBody = req.body && typeof req.body.sessionId === 'string'
      ? req.body.sessionId
      : null;
    const identity = sessionHeader || sessionBody || req.ip || 'anon';

    const key = `${prefix}${identity}`;

    // If we have redis → use atomic INCR + EXPIRE
    if (redis) {
      try {
        // INCR
        const count = await redis.incr(key);
        if (count === 1) {
          // first hit in window → set TTL
          await redis.expire(key, windowSeconds);
        }

        if (count > maxRequests) {
          const ttl = await redis.ttl(key);
          return res.status(429).json({
            success: false,
            error: 'Rate limit exceeded. Please try again later.',
            retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
          });
        }

        return next();
      } catch (err) {
        console.warn('[rateLimiter] redis failed, falling back to next()', err?.message || err);
        return next();
      }
    }

    // fallback: in-memory (not for prod)
    const now = Date.now();
    const bucket = memory.get(key);

    if (!bucket) {
      memory.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return next();
    }

    if (now > bucket.resetAt) {
      // window expired
      memory.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return next();
    }

    if (bucket.count >= maxRequests) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please try again later.',
        retryAfterSeconds: retryAfter,
      });
    }

    bucket.count += 1;
    return next();
  };
}
