import crypto from 'crypto';
import Redis from 'ioredis';
import { LRUCache } from 'lru-cache';

// Utilities to encode/decode Float32 vectors to compact base64 (compatible with embeddingCache)
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

// Simple PRNG (mulberry32) and Box-Muller to generate deterministic pseudo-Gaussian vectors
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianRand(rng) {
  // Box-Muller transform
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s) || 1e-12;
}

function cosineSimilarity(a, b) {
  return dot(a, b) / (norm(a) * norm(b));
}

function toFloat32(arr) {
  if (Array.isArray(arr)) return Array.from(arr, Number);
  if (arr instanceof Float32Array) return Array.from(arr);
  return Array.from(arr || []);
}

// Locality-Sensitive Hashing using random hyperplanes
class RandomHyperplaneLSH {
  constructor({ bits = 16, seed = 'default', modelKey = 'default' } = {}) {
    this.bits = bits;
    this.seed = seed;
    this.modelKey = modelKey;
    this.cache = new Map(); // key: dim -> hyperplanes
  }

  getHyperplanes(dim) {
    const key = `${dim}`;
    const hp = this.cache.get(key);
    if (hp) return hp;
    const seedHash = parseInt(stableHash(`${this.seed}:${this.modelKey}:${dim}`).slice(0, 8), 16) >>> 0;
    const rng = mulberry32(seedHash);
    const planes = new Array(this.bits);
    for (let b = 0; b < this.bits; b++) {
      const v = new Array(dim);
      for (let i = 0; i < dim; i++) v[i] = gaussianRand(rng);
      // Normalize the hyperplane vector to unit length to improve numerical stability
      const n = norm(v);
      for (let i = 0; i < dim; i++) v[i] /= n;
      planes[b] = v;
    }
    this.cache.set(key, planes);
    return planes;
  }

  signature(vector, dimOverride) {
    const v = toFloat32(vector);
    const dim = dimOverride || v.length;
    const planes = this.getHyperplanes(dim);
    let sig = 0;
    for (let b = 0; b < this.bits; b++) {
      const side = dot(v, planes[b]) >= 0 ? 1 : 0;
      sig |= side << b;
    }
    return sig >>> 0; // unsigned 32-bit
  }

  // Generate neighbor signatures within a small Hamming radius
  neighbors(sig, radius = 1) {
    const res = [sig >>> 0];
    if (radius <= 0) return res;
    const B = this.bits;
    // radius 1
    for (let i = 0; i < B; i++) res.push((sig ^ (1 << i)) >>> 0);
    if (radius >= 2) {
      for (let i = 0; i < B; i++) {
        for (let j = i + 1; j < B; j++) res.push((sig ^ (1 << i) ^ (1 << j)) >>> 0);
      }
    }
    return res;
  }
}

export class ResponseCache {
  constructor(opts = {}) {
    const {
      redisUrl = process.env.REDIS_URL,
      redisOptions = undefined,
      ttlSeconds = Number(process.env.RESPONSE_CACHE_TTL_SECONDS || 7 * 24 * 3600), // 7 days
      namespace = 'resp:v1',
      memoryMaxItems = 1000,
      lshBits = Number(process.env.RESPONSE_CACHE_LSH_BITS || 16),
      threshold = Number(process.env.RESPONSE_CACHE_SIM_THRESHOLD || 0.92),
      hammingRadius = Number(process.env.RESPONSE_CACHE_LSH_RADIUS || 1),
      modelKey = 'default', // e.g., 'cohere-embed-english-v3.0'
      maxCandidates = Number(process.env.RESPONSE_CACHE_MAX_CANDIDATES || 200),
    } = opts;

    this.namespace = namespace;
    this.ttlSeconds = ttlSeconds;
    this.hits = 0;
    this.misses = 0;
    this.modelKey = modelKey;
    this.threshold = threshold;
    this.hammingRadius = hammingRadius;
    this.maxCandidates = maxCandidates;

    this.lsh = new RandomHyperplaneLSH({ bits: lshBits, seed: namespace, modelKey });
    this.bits = lshBits;

    if (redisUrl) {
      this.backend = 'redis';
      this.redis = new Redis(redisUrl, redisOptions);
      this.redis.on('error', (e) => {
        console.warn('[ResponseCache] Redis error:', e?.message || e);
      });
    } else {
      this.backend = 'memory';
      // id -> record
      this.items = new LRUCache({
        max: memoryMaxItems,
        ttl: ttlSeconds > 0 ? ttlSeconds * 1000 : 0,
        // When evicted/expired, clean bucket index
        dispose: (val, key) => {
          try {
            if (val && val.bucketKeys) {
              for (const bk of val.bucketKeys) {
                const s = this.bucketMap.get(bk);
                if (s) {
                  s.delete(key);
                  if (s.size === 0) this.bucketMap.delete(bk);
                }
              }
            }
          } catch {}
        },
      });
      // bucketKey -> Set<id>
      this.bucketMap = new Map();
      console.warn('[ResponseCache] REDIS_URL not set. Using in-memory LRU response cache.');
    }
  }

  itemKey(id) {
    return `${this.namespace}:item:${id}`;
  }

  bucketKey(sig) {
    // isolate per modelKey and bit-length
    return `${this.namespace}:b:${this.modelKey}:${this.bits}:${sig.toString(16)}`;
  }

  makeId(vector, payload) {
    const b64 = floatArrayToBase64(vector);
    const txt = typeof payload?.responseText === 'string' ? payload.responseText : '';
    return stableHash(`${b64}:${txt}`);
  }

  async put(vectorInput, payload = {}) {
    const vector = toFloat32(vectorInput);
    const dim = vector.length;
    const id = this.makeId(vector, payload);
    const item = {
      id,
      modelKey: this.modelKey,
      dim,
      created_at: new Date().toISOString(),
      vector_b64: floatArrayToBase64(vector),
      responseText: payload.responseText ?? null,
      metadata: payload.metadata ?? null,
      question: payload.question ?? null,
      ttlSeconds: this.ttlSeconds,
    };

    const sig = this.lsh.signature(vector, dim);
    const bKey = this.bucketKey(sig);

    if (this.backend === 'redis') {
      const itKey = this.itemKey(id);
      try {
        // Store item with TTL
        if (this.ttlSeconds > 0) {
          await this.redis.set(itKey, JSON.stringify(item), 'EX', this.ttlSeconds);
        } else {
          await this.redis.set(itKey, JSON.stringify(item));
        }
        // Add to bucket set and cap size randomly if too big
        await this.redis.sadd(bKey, id);
        if (this.ttlSeconds > 0) await this.redis.expire(bKey, this.ttlSeconds);
        const maxBucketSize = 1000;
        try {
          const sz = await this.redis.scard(bKey);
          if (sz > maxBucketSize) {
            await this.redis.spop(bKey, sz - maxBucketSize);
          }
        } catch {}
        console.log(`[ResponseCache] SET backend=redis id=${id} bucket=${bKey}`);
      } catch (e) {
        console.warn('[ResponseCache] Redis put failed:', e?.message || e);
      }
    } else {
      // Memory backend
      const it = { ...item, vector }; // keep raw vector for fast similarity
      // Track bucket membership for cleanup
      const bk = bKey;
      it.bucketKeys = [bk];
      this.items.set(id, it);
      let set = this.bucketMap.get(bk);
      if (!set) {
        set = new Set();
        this.bucketMap.set(bk, set);
      }
      set.add(id);
      console.log(`[ResponseCache] SET backend=memory id=${id} bucket=${bKey}`);
    }

    return id;
  }

  async getSimilar(vectorInput, opts = {}) {
    const vector = toFloat32(vectorInput);
    const dim = vector.length;
    const sig = this.lsh.signature(vector, dim);
    const radius = Number(opts.radius ?? this.hammingRadius);
    const threshold = Number(opts.threshold ?? this.threshold);
    const maxCandidates = Number(opts.maxCandidates ?? this.maxCandidates);

    let candidateIds = [];

    if (this.backend === 'redis') {
      try {
        const codes = this.lsh.neighbors(sig, radius);
        const bucketKeys = codes.map((c) => this.bucketKey(c));
        // Use SUNION to get a unique set of candidate IDs
        candidateIds = await this.redis.sunion(bucketKeys);
      } catch (e) {
        console.warn('[ResponseCache] Redis candidate fetch failed:', e?.message || e);
        candidateIds = [];
      }

      // Fetch candidate items in batches
      let best = null;
      const ids = candidateIds.slice(0, maxCandidates);
      if (ids.length > 0) {
        const itKeys = ids.map((id) => this.itemKey(id));
        const raws = await this.redis.mget(itKeys);
        const toCleanup = [];
        for (let i = 0; i < ids.length; i++) {
          const raw = raws[i];
          if (!raw) {
            // stale id in bucket; schedule cleanup
            toCleanup.push(ids[i]);
            continue;
          }
          try {
            const obj = JSON.parse(raw);
            const vec = base64ToFloatArray(obj.vector_b64);
            const sim = cosineSimilarity(vector, vec);
            if (!best || sim > best.similarity) best = { id: obj.id, similarity: sim, item: obj };
          } catch {}
        }
        // Lazy-clean stale ids from each bucket we touched
        if (toCleanup.length) {
          const codes = this.lsh.neighbors(sig, radius);
          const bucketKeys = codes.map((c) => this.bucketKey(c));
          try {
            // Best-effort cleanup: remove stale ids from all relevant buckets
            for (const bk of bucketKeys) {
              if (toCleanup.length) await this.redis.srem(bk, ...toCleanup);
            }
          } catch {}
        }

      }

      if (best && best.similarity >= threshold) {
        this.hits++;
        console.log(`[ResponseCache] HIT backend=redis id=${best.id} sim=${best.similarity.toFixed(4)}`);
        return { hit: true, similarity: best.similarity, item: best.item };
      }
      this.misses++;
      console.log(`[ResponseCache] MISS backend=redis candidates=${candidateIds.length}`);
      return { hit: false, similarity: best ? best.similarity : 0, item: best ? best.item : null };

    } else {
      // Memory backend: gather candidate ids from buckets
      const codes = this.lsh.neighbors(sig, radius);
      const idSet = new Set();
      for (const c of codes) {
        const bk = this.bucketKey(c);
        const s = this.bucketMap.get(bk);
        if (s) for (const id of s) idSet.add(id);
      }
      const ids = Array.from(idSet).slice(0, maxCandidates);
      let best = null;
      for (const id of ids) {
        const rec = this.items.get(id);
        if (!rec || !rec.vector) continue;
        const sim = cosineSimilarity(vector, rec.vector);
        if (!best || sim > best.similarity) best = { id, similarity: sim, item: rec };
      }
      if (best && best.similarity >= threshold) {
        this.hits++;
        console.log(`[ResponseCache] HIT backend=memory id=${best.id} sim=${best.similarity.toFixed(4)}`);
        return { hit: true, similarity: best.similarity, item: this.stripMemoryItem(best.item) };
      }
      this.misses++;
      console.log(`[ResponseCache] MISS backend=memory candidates=${ids.length}`);
      return { hit: false, similarity: best ? best.similarity : 0, item: best ? this.stripMemoryItem(best.item) : null };
    }
  }

  stripMemoryItem(it) {
    // Return a plain object similar to Redis-stored item
    if (!it) return null;
    const { vector, bucketKeys, ...rest } = it;
    return rest;
  }

  getStats() {
    const items = this.backend === 'memory' ? this.items.size : undefined;
    return {
      backend: this.backend,
      ttlSeconds: this.ttlSeconds,
      hits: this.hits,
      misses: this.misses,
      namespace: this.namespace,
      lshBits: this.bits,
      hammingRadius: this.hammingRadius,
      threshold: this.threshold,
      modelKey: this.modelKey,
      items,
    };
  }
}

