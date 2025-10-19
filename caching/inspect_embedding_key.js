import dotenv from 'dotenv';
dotenv.config();

import Redis from 'ioredis';
import { EmbeddingCache } from './embeddingCache.js';
import { normalizeQuery } from './normalization.js';

function parseArgs(argv) {
  const args = {
    key: null,
    query: null,
    namespace: process.env.EMBEDDING_CACHE_NS || 'emb:v1',
    redis: process.env.REDIS_URL || 'redis://localhost:6379',
    showVector: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key' && i + 1 < argv.length) args.key = argv[++i];
    else if (a === '--query' && i + 1 < argv.length) args.query = argv[++i];
    else if (a === '--namespace' && i + 1 < argv.length) args.namespace = argv[++i];
    else if (a === '--redis' && i + 1 < argv.length) args.redis = argv[++i];
    else if (a === '--show-vector') args.showVector = true;
  }
  return args;
}

function base64ToFloatArray(b64) {
  const buf = Buffer.from(b64, 'base64');
  const float32 = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  return Array.from(float32);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const redis = new Redis(args.redis);
  redis.on('error', (e) => console.warn('[Redis] error:', e?.message || e));

  let key = args.key;
  let qNorm = null;
  if (!key) {
    if (!args.query) {
      console.error('Provide either --key <redis-key> or --query "text"');
      process.exit(1);
    }
    qNorm = normalizeQuery(args.query);
    const tempCache = new EmbeddingCache({ redisUrl: args.redis, namespace: args.namespace });
    key = tempCache.keyForQuery(qNorm);
  }

  const [type, ttl, raw] = await Promise.all([
    redis.type(key),
    redis.ttl(key),
    redis.get(key),
  ]);

  console.log('--- Inspect Embedding Cache Key ---');
  console.log('Redis URL:', args.redis);
  console.log('Namespace:', args.namespace);
  if (qNorm) console.log('q_norm:', qNorm);
  console.log('Key:', key);
  console.log('Type:', type);
  console.log('TTL (s):', ttl);

  if (!raw) {
    console.log('No value found for the given key.');
    await redis.quit();
    return;
  }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    console.log('Value is not valid JSON. First 200 chars:');
    console.log(raw.slice(0, 200));
    await redis.quit();
    return;
  }

  console.log('Stored JSON fields:');
  console.log(' - q_norm:', obj.q_norm);
  console.log(' - created_at:', obj.created_at);
  console.log(' - vector_b64 length:', obj.vector_b64 ? obj.vector_b64.length : 'N/A');

  if (obj.vector_b64) {
    const vec = base64ToFloatArray(obj.vector_b64);
    console.log('Decoded vector:');
    console.log(' - dimension:', vec.length);
    if (args.showVector) {
      const head = vec.slice(0, 16).map(v => v.toFixed(6)).join(', ');
      console.log(' - first 16 values:', `[${head}]`);
    }
  }

  await redis.quit();
}

main().catch((e) => {
  console.error('Inspect failed:', e?.message || e);
  process.exit(1);
});

