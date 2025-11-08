import Redis from 'ioredis';
import { LRUCache } from 'lru-cache';

const VALID_ROLES = new Set(['user', 'assistant', 'system']);

export class ChatHistory {
  constructor(opts = {}) {
    const {
      redisUrl = process.env.REDIS_URL,
      redisOptions = undefined,
      namespace = 'chat:v1',
      perSessionLimit = Number(process.env.CHAT_HISTORY_LIMIT || 30),
      memoryMaxSessions = 500,
      sessionTtlSeconds = 24 * 3600,
    } = opts;

    this.namespace = namespace;
    this.perSessionLimit = Number.isFinite(perSessionLimit) && perSessionLimit > 0 ? perSessionLimit : 30;
    this.sessionTtlSeconds = sessionTtlSeconds;

    if (redisUrl) {
      this.backend = 'redis';
      this.redis = new Redis(redisUrl, redisOptions);
      this.redis.on('error', (e) => {
        console.warn('[ChatHistory] Redis error:', e?.message || e);
      });
    } else {
      this.backend = 'memory';
      this.lru = new LRUCache({ max: memoryMaxSessions });
      console.warn('[ChatHistory] REDIS_URL not set. Using in-memory LRU for sessions.');
    }
  }

  key(sessionId) {
    return `${this.namespace}:s:${sessionId}`;
  }

  normalizeMessage(message = {}) {
    const roleInput = typeof message.role === 'string' ? message.role.toLowerCase() : 'user';
    const role = VALID_ROLES.has(roleInput) ? roleInput : 'user';
    const content = typeof message.content === 'string' ? message.content : '';
    const at = message.at || new Date().toISOString();
    return { role, content, at };
  }

  async appendMessage(sessionId, message) {
    if (!sessionId) return;
    const payload = this.normalizeMessage(message);

    if (this.backend === 'redis') {
      const key = this.key(sessionId);
      await this.redis.lpush(key, JSON.stringify(payload));
      await this.redis.ltrim(key, 0, this.perSessionLimit - 1);
      if (this.sessionTtlSeconds > 0) {
        await this.redis.expire(key, this.sessionTtlSeconds);
      }
    } else {
      const existing = this.lru.get(sessionId) || [];
      existing.unshift(payload);
      if (existing.length > this.perSessionLimit) {
        existing.length = this.perSessionLimit;
      }
      this.lru.set(sessionId, existing);
    }
  }

  async getHistory(sessionId) {
    if (!sessionId) return [];
    if (this.backend === 'redis') {
      const key = this.key(sessionId);
      const raw = await this.redis.lrange(key, 0, this.perSessionLimit - 1);
      if (!Array.isArray(raw) || raw.length === 0) return [];
      const parsed = raw
        .map((entry) => {
          try {
            return JSON.parse(entry);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      return parsed.reverse();
    }
    const arr = this.lru.get(sessionId) || [];
    return [...arr].reverse();
  }

  async clear(sessionId) {
    if (!sessionId) return;
    if (this.backend === 'redis') {
      await this.redis.del(this.key(sessionId));
    } else {
      this.lru.delete(sessionId);
    }
  }
}
