import 'dotenv/config';
import Redis from 'ioredis';
import { ResponseCache } from './responseCache.js';

function parseArgs(argv) {
  const args = {
    dim: Number(process.env.TEST_DIM || 1024),
    redis: process.env.REDIS_URL || null,
    bits: Number(process.env.RESPONSE_CACHE_LSH_BITS || 16),
    radius: Number(process.env.RESPONSE_CACHE_LSH_RADIUS || 1),
    threshold: Number(process.env.RESPONSE_CACHE_SIM_THRESHOLD || 0.92),
    modelKey: process.env.COHERE_EMBED_MODEL || 'embed-english-v3.0',
    ttl: Number(process.env.RESPONSE_CACHE_TTL_SECONDS || 3600),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dim' && i + 1 < argv.length) args.dim = Number(argv[++i]);
    else if (a === '--redis' && i + 1 < argv.length) args.redis = argv[++i];
    else if (a === '--bits' && i + 1 < argv.length) args.bits = Number(argv[++i]);
    else if (a === '--radius' && i + 1 < argv.length) args.radius = Number(argv[++i]);
    else if (a === '--threshold' && i + 1 < argv.length) args.threshold = Number(argv[++i]);
    else if (a === '--model' && i + 1 < argv.length) args.modelKey = argv[++i];
    else if (a === '--ttl' && i + 1 < argv.length) args.ttl = Number(argv[++i]);
  }
  return args;
}

function randn() {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function makeVector(dim) {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) v[i] = randn();
  // normalize
  let n = 0; for (let i = 0; i < dim; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1e-12;
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

function addNoise(vec, scale = 0.05) {
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] + randn() * scale;
  // renormalize
  let n = 0; for (let i = 0; i < out.length; i++) n += out[i] * out[i];
  n = Math.sqrt(n) || 1e-12;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const useRedis = !!args.redis;

  const cache = new ResponseCache({
    redisUrl: args.redis || undefined,
    ttlSeconds: args.ttl,
    lshBits: args.bits,
    hammingRadius: args.radius,
    threshold: args.threshold,
    modelKey: args.modelKey,
    namespace: 'resp:test',
  });

  console.log('--- Response Cache Test ---');
  console.log('Backend:', cache.backend);
  console.log('Dim:', args.dim);
  console.log('LSH bits:', args.bits);
  console.log('Radius:', args.radius);
  console.log('Threshold:', args.threshold);
  console.log('ModelKey:', args.modelKey);

  // Base vector and response
  const base = makeVector(args.dim);
  const resp = {
    responseText: 'This is a cached answer for a topic.',
    metadata: { source: 'unit-test', tags: ['demo'] },
    question: 'What are the placement stats at NIT Jamshedpur?'
  };
  await cache.put(base, resp);

  // Query with small noise (should HIT)
  const q1 = addNoise(base, 0.001);
  const r1 = await cache.getSimilar(q1);
  console.log('Query #1 (similar):', r1);

  // Query with bigger noise (may MISS depending on threshold)
  const q2 = addNoise(base, 0.2);
  const r2 = await cache.getSimilar(q2);
  console.log('Query #2 (noisier):', r2);

  // Completely different vector (MISS)
  const other = makeVector(args.dim);
  const r3 = await cache.getSimilar(other);
  console.log('Query #3 (different):', r3);

  console.log('Cache stats:', cache.getStats());

  if (useRedis) {
    const redis = new Redis(args.redis);
    await redis.quit();
  }
}

main().catch((e) => {
  console.error('Response cache test failed:', e?.message || e);
  process.exit(1);
});

