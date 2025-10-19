import crypto from 'crypto';
import Redis from 'ioredis';
import { LRUCache } from 'lru-cache';
import { normalizeQuery } from './normalization.js';

function floatArrayToBase64(arr) {
  const float32 = new Float32Array(arr);
  const buf = Buffer.from(float32.buffer);
  return buf.toString('base64');
}

function base64ToFloatArray(b64) {
  const buf = Buffer.from(b64, 'base64');
  const float32 = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  return Array.from(float32);
}

function stableHash(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
}

export class EmbeddingCache {
  constructor(opts = {}) {
    const {
      redisUrl = process.env.REDIS_URL,
      redisOptions = undefined,
      ttlSeconds = Number(process.env.EMBEDDING_CACHE_TTL_SECONDS || 30 * 24 * 3600), // 30 days
      namespace = 'emb:v1',
      memoryMax = 1000,
    } = opts;

    this.namespace = namespace;
    this.ttlSeconds = ttlSeconds;
    this.hits = 0;
    this.misses = 0;

    if (redisUrl) {
      this.backend = 'redis';
      this.redis = new Redis(redisUrl, redisOptions);
      this.redis.on('error', (e) => {
        console.warn('[EmbeddingCache] Redis error:', e?.message || e);
      });
    } else {
      this.backend = 'memory';
      this.lru = new LRUCache({ max: memoryMax, ttl: ttlSeconds * 1000 });
      console.warn('[EmbeddingCache] REDIS_URL not set. Falling back to in-memory LRU cache.');
    }
  }

  keyForQuery(qNorm) {
    // Exact mapping for normalized query, but keyed by a stable hash to keep keys short
    const h = stableHash(qNorm);
    return `${this.namespace}:q:${h}`;
  }

  async getQueryEmbedding(query, embedFn) {
    const qNorm = normalizeQuery(query);
    const key = this.keyForQuery(qNorm);

    // Try cache
    if (this.backend === 'redis') {
      try {
        const raw = await this.redis.get(key);
        if (raw) {
          const obj = JSON.parse(raw);
          this.hits++;
          return base64ToFloatArray(obj.vector_b64);
        }
      } catch (e) {
        console.warn('[EmbeddingCache] Redis get failed:', e?.message || e);
      }
    } else {
      const obj = this.lru.get(key);
      if (obj) {
        this.hits++;
        return base64ToFloatArray(obj.vector_b64);
      }
    }

    // Miss: compute
    this.misses++;
    const vector = await embedFn(query);
    const payload = {
      q_norm: qNorm,
      vector_b64: floatArrayToBase64(vector),
      created_at: new Date().toISOString(),
    };

    // Store
    if (this.backend === 'redis') {
      try {
        if (this.ttlSeconds > 0) {
          await this.redis.set(key, JSON.stringify(payload), 'EX', this.ttlSeconds);
        } else {
          await this.redis.set(key, JSON.stringify(payload));
        }
      } catch (e) {
        console.warn('[EmbeddingCache] Redis set failed:', e?.message || e);
      }
    } else {
      this.lru.set(key, payload);
    }

    return vector;
  }

  getStats() {
    return {
      backend: this.backend,
      ttlSeconds: this.ttlSeconds,
      hits: this.hits,
      misses: this.misses,
      namespace: this.namespace,
    };
  }
}
