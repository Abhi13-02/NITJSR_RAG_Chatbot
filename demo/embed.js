import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';
import { DemoRAGSystem } from './AltRagSystem.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function findLatestDemoFile(dir) {
  try {
    const files = await fs.readdir(dir);
    const jsons = files.filter(f => f.endsWith('.json')).sort().reverse();
    if (jsons.length === 0) return null;
    return path.join(dir, jsons[0]);
  } catch {
    return null;
  }
}

function reduceDataForEmbedding(data) {
  const maxPages = parseInt(process.env.DEMO_MAX_PAGES || '5', 10);
  const maxChars = parseInt(process.env.DEMO_MAX_CHARS || '4000', 10);
  const clone = JSON.parse(JSON.stringify(data));
  clone.pages = (clone.pages || []).slice(0, maxPages).map(p => {
    if (p.content && typeof p.content === 'string') p.content = p.content.slice(0, maxChars);
    if (Array.isArray(p.rawContent)) p.rawContent = p.rawContent.join(' ').slice(0, maxChars);
    if (Array.isArray(p.tables)) p.tables = p.tables.slice(0, 1);
    if (Array.isArray(p.lists)) p.lists = p.lists.slice(0, 2);
    return p;
  });
  return clone;
}

async function embedDemoData({ file, skipPdf = true }) {
  const rag = new DemoRAGSystem();
  await rag.initialize();

  const raw = await fs.readFile(file, 'utf8');
  const scraped = JSON.parse(raw);

  if (skipPdf) {
    if (!scraped.documents) scraped.documents = {};
    scraped.documents.pdfs = [];
    if (scraped.links && scraped.links.pdf) scraped.links.pdf = [];
  }

  const reduced = reduceDataForEmbedding(scraped);
  console.log('Embedding demo data into vector DB (limited set)...');
  try {
    await rag.processAndStoreDocuments(reduced);
    console.log('Done.');
  } catch (e) {
    console.error('Embedding failed (likely quota). You can still run demo server in local-fallback:', e.message);
  }
}

async function main() {
  const dataDir = path.join(__dirname, 'data');
  const fileArg = process.argv.find(a => a.startsWith('--file='))?.split('=')[1];
  const skipPdf = !process.argv.includes('--include-pdf');

  const file = fileArg || await findLatestDemoFile(dataDir);
  if (!file) {
    console.error('No demo data file found. Run `node demo/scrape.js` first.');
    process.exit(1);
  }
  console.log(`Embedding demo data file: ${file}`);
  await embedDemoData({ file, skipPdf });
}

if (import.meta.url === pathToFileURL(__filename).href) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export { embedDemoData };
