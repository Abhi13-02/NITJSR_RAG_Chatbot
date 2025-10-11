import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';
import { NITJSRRAGSystem } from '../RagSystem.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function normalize(t) { return (t || '').replace(/\s+/g, ' ').trim(); }
function tokenize(t) { return normalize(t).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }

async function loadLatestDemoFile() {
  const dir = path.join(__dirname, 'data');
  const files = await fs.readdir(dir).catch(() => []);
  const jsons = files.filter(f => f.endsWith('.json')).sort().reverse();
  if (jsons.length === 0) throw new Error('No demo data found. Run demo/scrape.js first.');
  return JSON.parse(await fs.readFile(path.join(dir, jsons[0]), 'utf8'));
}

function buildLocalIndex(data) {
  return (data.pages || []).map(page => {
    const parts = [];
    if (page.title) parts.push(`Title: ${page.title}`);
    parts.push(page.url);
    if (page.headings?.length) parts.push(page.headings.map(h => h.text).join('\n'));
    if (Array.isArray(page.rawContent)) parts.push(page.rawContent.join('\n'));
    else if (page.content) parts.push(page.content);
    const text = normalize(parts.filter(Boolean).join('\n'));
    return { url: page.url, title: page.title || page.url, text, category: page.category || 'general' };
  });
}

function score(qTokens, doc) {
  const dtokens = tokenize(doc.text);
  if (!dtokens.length) return 0;
  let s = 0;
  for (const qt of qTokens) {
    const cnt = dtokens.filter(t => t === qt).length;
    s += cnt * 3;
    if (!cnt) s += dtokens.some(t => t.includes(qt)) ? 1 : 0;
  }
  return s / Math.sqrt(dtokens.length);
}

async function run() {
  const mode = (process.argv.find(a => a.startsWith('--mode='))?.split('=')[1] || 'local');
  const qArg = process.argv.find(a => a.startsWith('--q='))?.split('=')[1];
  const question = qArg || process.argv.slice(2).join(' ');
  if (!question) {
    console.error('Usage: node demo/retrieve.js --mode=local|vector --q="your question"');
    process.exit(1);
  }

  const data = await loadLatestDemoFile();

  if (mode === 'local') {
    const idx = buildLocalIndex(data);
    const qTokens = tokenize(question);
    const scored = idx.map(d => ({ d, s: score(qTokens, d) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 5);
    const top = scored.filter(x => x.s > 0);
    console.log('Top sources:');
    for (const t of top) console.log(`- ${t.d.title} (${t.d.url}) [${t.s.toFixed(3)}]`);
    const ctx = top.map(x => `${x.d.title}: ${x.d.text.substring(0, 600)}`).join('\n\n');
    console.log('\nAnswer (context-based):');
    console.log(ctx || 'No relevant context found.');
  } else {
    const rag = new NITJSRRAGSystem();
    await rag.initialize();
    rag.buildLinkDatabase(data);
    const r = await rag.queryDocuments(question, 6);
    console.log('\nAnswer (vector):');
    console.log(r.answer);
    console.log('\nSources:');
    for (const s of r.sources || []) console.log(`- ${s.title || s.url} -> ${s.url}`);
  }
}

if (import.meta.url === pathToFileURL(__filename).href) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
