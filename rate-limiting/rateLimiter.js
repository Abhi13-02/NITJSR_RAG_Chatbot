/**
 * Rate limiter middleware.
 *
 * Behavior:
 * - Enforces a GLOBAL limit first (all requests combined).
 * - Then enforces a per-SESSION limit only if a sessionId is present
 *   (via `x-session-id` header or `req.body.sessionId`).
 * - No IP-based limiting or fallback.
 *
 * Back-compat options:
 * - `maxRequests` (legacy) applies to BOTH global and per-session if
 *    explicit `maxGlobal` / `maxPerSession` are not provided.
 */
export function createRateLimiter({
  redis = null,
  windowSeconds = 60,
  maxRequests = 30, // legacy default
  maxGlobal = 10,
  maxPerSession = 2,
  prefix = 'rl:chat:v1:',
} = {}) {
  // in-memory fallback (dev only)
  const memory = new Map();

  // normalize limits
  const globalLimit = Number.isFinite(maxGlobal)
    ? Number(maxGlobal)
    : Number(maxRequests);
  const sessionLimit = Number.isFinite(maxPerSession)
    ? Number(maxPerSession)
    : Number(maxRequests);

  function incrMemory(key, now, winMs) {
    const bucket = memory.get(key);
    if (!bucket || now > bucket.resetAt) {
      const fresh = { count: 1, resetAt: now + winMs };
      memory.set(key, fresh);
      return fresh;
    }
    bucket.count += 1;
    return bucket;
  }

  return async function rateLimiter(req, res, next) {
    // derive session id only; do NOT use IP fallback
    const sessionHeader = typeof req.headers['x-session-id'] === 'string'
      ? req.headers['x-session-id']
      : null;
    const sessionBody = req.body && typeof req.body.sessionId === 'string'
      ? req.body.sessionId
      : null;
    const sessionId = sessionHeader || sessionBody || null;

    const globalKey = `${prefix}GLOBAL`;
    const sessionKey = sessionId ? `${prefix}s:${sessionId}` : null;

    // Prefer Redis for atomic counters
    if (redis) {
      try {
        // GLOBAL first
        const globalCount = await redis.incr(globalKey);
        if (globalCount === 1) {
          await redis.expire(globalKey, windowSeconds);
        }
        if (globalCount > globalLimit) {
          const ttl = await redis.ttl(globalKey);
          return res.status(429).json({
            success: false,
            error: 'Rate limit exceeded. Please try again later.',
            retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
            limitType: 'global',
          });
        }

        // If session is present, enforce per-session
        if (sessionKey) {
          const sessCount = await redis.incr(sessionKey);
          if (sessCount === 1) {
            await redis.expire(sessionKey, windowSeconds);
          }
          if (sessCount > sessionLimit) {
            const ttl = await redis.ttl(sessionKey);
            return res.status(429).json({
              success: false,
              error: 'Rate limit exceeded. Please try again later.',
              retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
              limitType: 'session',
            });
          }
        }

        return next();
      } catch (err) {
        console.warn('[rateLimiter] redis failed, falling back to in-memory', err?.message || err);
        // fall through to memory path
      }
    }

    // fallback: in-memory (not for prod)
    const now = Date.now();
    const winMs = windowSeconds * 1000;

    // GLOBAL first
    const g = incrMemory(globalKey, now, winMs);
    if (g.count > globalLimit) {
      const retryAfter = Math.ceil((g.resetAt - now) / 1000);
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please try again later.',
        retryAfterSeconds: retryAfter,
        limitType: 'global',
      });
    }

    // Per-session only if we have a sessionId
    if (sessionKey) {
      const s = incrMemory(sessionKey, now, winMs);
      if (s.count > sessionLimit) {
        const retryAfter = Math.ceil((s.resetAt - now) / 1000);
        return res.status(429).json({
          success: false,
          error: 'Rate limit exceeded. Please try again later.',
          retryAfterSeconds: retryAfter,
          limitType: 'session',
        });
      }
    }

    return next();
  };
}

