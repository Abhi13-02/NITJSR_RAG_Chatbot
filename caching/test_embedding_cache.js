import dotenv from 'dotenv';
dotenv.config();

import { CohereEmbeddings } from '@langchain/cohere';
import Redis from 'ioredis';

import { EmbeddingCache } from './embeddingCache.js';
import { normalizeQuery } from './normalization.js';

function parseArgs(argv) {
  const args = {
    query: 'What are the placement stats at NIT Jamshedpur?',
    model: process.env.COHERE_EMBED_MODEL || 'embed-english-v3.0',
    ttl: Number(process.env.EMBEDDING_CACHE_TTL_SECONDS || 30 * 24 * 3600),
    namespace: 'emb:test',
    repeats: 2,
    redis: process.env.REDIS_URL || null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--query' && i + 1 < argv.length) args.query = argv[++i];
    else if (a === '--model' && i + 1 < argv.length) args.model = argv[++i];
    else if (a === '--ttl' && i + 1 < argv.length) args.ttl = Number(argv[++i]);
    else if (a === '--namespace' && i + 1 < argv.length) args.namespace = argv[++i];
    else if (a === '--repeats' && i + 1 < argv.length) args.repeats = Number(argv[++i]);
    else if (a === '--redis' && i + 1 < argv.length) args.redis = argv[++i];
  }
  return args;
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return NaN;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.COHERE_API_KEY) {
    console.error('[ERROR] COHERE_API_KEY is not set.');
    process.exit(1);
  }

  if (!args.redis) {
    console.warn('[WARN] REDIS_URL not set. This test prefers Redis, but will fall back to in-memory cache.');
  }

  // Build embeddings client for query-embedding
  const embeddings = new CohereEmbeddings({
    apiKey: process.env.COHERE_API_KEY,
    model: args.model,
    // For queries, Cohere recommends inputType: 'search_query'
    inputType: 'search_query',
  });

  // Build Redis (optional) for showing raw storage
  const redis = args.redis ? new Redis(args.redis) : null;
  if (redis) {
    redis.on('error', (e) => console.warn('[Redis] error:', e?.message || e));
  }

  // Build cache with requested TTL + namespace
  const cache = new EmbeddingCache({
    redisUrl: args.redis || undefined,
    ttlSeconds: args.ttl,
    namespace: args.namespace,
  });

  const q = args.query;
  const qNorm = normalizeQuery(q);
  const cacheKey = cache.keyForQuery(qNorm);

  console.log('--- Embedding Cache Test (Redis + Cohere) ---');
  console.log('Query:', q);
  console.log('q_norm:', qNorm);
  console.log('Namespace:', args.namespace);
  console.log('Cache key:', cacheKey);
  console.log('Model:', args.model);
  console.log('TTL (s):', args.ttl);
  console.log('Backend:', cache.backend);

  // Clean existing key to force a miss on first run
  if (redis) {
    await redis.del(cacheKey).catch(() => {});
  }

  // First call – expect MISS
  const t0 = Date.now();
  const v1 = await cache.getQueryEmbedding(q, (text) => embeddings.embedQuery(text));
  const dt1 = Date.now() - t0;
  console.log('Run #1: MISS expected');
  console.log(' - Time (ms):', dt1);
  console.log(' - Dim:', Array.isArray(v1) ? v1.length : 'N/A');

  // Inspect stored value in Redis directly (if Redis)
  if (redis) {
    const raw = await redis.get(cacheKey);
    if (raw) {
      const obj = JSON.parse(raw);
      console.log('Stored record (Redis):');
      console.log(' - created_at:', obj.created_at);
      console.log(' - vector_b64 length:', obj.vector_b64.length);
    } else {
      console.log('No record found in Redis (did REDIS_URL point to the right instance?)');
    }
  }

  // Second call – expect HIT
  const t1 = Date.now();
  const v2 = await cache.getQueryEmbedding(q, (text) => embeddings.embedQuery(text));
  const dt2 = Date.now() - t1;
  console.log('Run #2: HIT expected');
  console.log(' - Time (ms):', dt2);
  console.log(' - Dim:', Array.isArray(v2) ? v2.length : 'N/A');
  console.log(' - Cosine similarity to Run #1:', cosineSimilarity(v1, v2).toFixed(6));

  // Third call – normalized alias (spacing/punct changes) should HIT same key
  const alias = '   what are   the placement stats, at NIT  JAMSHEDPUR???   ';
  const aliasNorm = normalizeQuery(alias);
  const aliasKey = cache.keyForQuery(aliasNorm);
  const t2 = Date.now();
  const v3 = await cache.getQueryEmbedding(alias, (text) => embeddings.embedQuery(text));
  const dt3 = Date.now() - t2;
  console.log('Run #3: alias string (HIT expected via normalization)');
  console.log(' - Alias:', alias);
  console.log(' - alias q_norm:', aliasNorm);
  console.log(' - alias cache key:', aliasKey);
  console.log(' - Same key as original?', aliasKey === cacheKey);
  console.log(' - Time (ms):', dt3);
  console.log(' - Cosine similarity to Run #1:', cosineSimilarity(v1, v3).toFixed(6));

  // Stats
  console.log('Cache stats:', cache.getStats());

  if (redis) await redis.quit();
}

main().catch((e) => {
  console.error('Test failed:', e?.message || e);
  process.exit(1);
});

