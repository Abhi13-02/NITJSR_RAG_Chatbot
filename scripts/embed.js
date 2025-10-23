import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { NITJSRRAGSystem } from '../RagSystem.js';
import { MongoClient } from 'mongodb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function parseArgs(argv) {
  const args = { file: null, latest: true, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--file' || a === '-f') && argv[i + 1]) { args.file = argv[++i]; args.latest = false; }
    else if (a === '--latest') { args.latest = true; args.file = null; }
    else if (a === '--force' || a === '-F') { args.force = true; }
  }
  return args;
}

async function pickLatestDataFile() {
  const dataDir = path.join(__dirname, '..', 'scraped_data');
  try {
    const files = await fs.readdir(dataDir);
    const jsons = files.filter(f => f.endsWith('.json')).sort().reverse();
    if (jsons.length === 0) return null;
    return path.join(dataDir, jsons[0]);
  } catch {
    return null;
  }
}

async function setupMongo() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    throw new Error('MONGODB_URI not set; cannot use Mongo-backed ledger ingestion.');
  }

  const dbName = (process.env.MONGODB_DB || 'nitjsr_rag').trim();
  const pagesName = (process.env.MONGO_PAGES_COLL || 'pages').trim();
  const chunksName = (process.env.MONGO_CHUNKS_COLL || 'chunks').trim();

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 7000 });
  await client.connect();
  const db = client.db(dbName);
  const mongo = {
    client,
    db,
    pagesColl: db.collection(pagesName),
    chunksColl: db.collection(chunksName),
    dbName,
    pagesName,
    chunksName,
    status: 'connected',
  };

  console.log(`[embed] Connected Mongo db=${dbName} pages=${pagesName} chunks=${chunksName}`);
  return mongo;
}

async function main() {
  const args = parseArgs(process.argv);

  let dataPath = args.file;
  if (!dataPath && args.latest) {
    dataPath = await pickLatestDataFile();
  }

  if (!dataPath) {
    console.error('[embed] No scraped data file found. Provide with --file or run scrape first.');
    process.exit(2);
  }

  console.log('[embed] Using data file:', dataPath);
  const scrapedData = JSON.parse(await fs.readFile(dataPath, 'utf8'));

  const mongo = await setupMongo();
  const rag = new NITJSRRAGSystem({ mongo });

  try {
    await rag.initialize();

    if (args.force) {
      console.log('[embed] --force set: clearing Pinecone index...');
      await rag.clearIndex();
    }

    console.log('[embed] Processing and uploading embeddings to Pinecone...');
    await rag.processAndStoreDocuments(scrapedData);

    const stats = await rag.getIndexStats();
    console.log('[embed] Done. Index stats:', stats);
  } finally {
    if (mongo?.client) {
      await mongo.client.close();
      console.log('[embed] Mongo connection closed.');
    }
  }
}

main().catch((e) => {
  console.error('[embed] Failed:', e?.message || e);
  process.exit(1);
});

