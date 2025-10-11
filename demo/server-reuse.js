import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { DemoRAGSystem } from './AltRagSystem.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class NITJSRReuseServer {
  constructor() {
    this.app = express();
    this.ragSystem = new DemoRAGSystem();
    this.isInitialized = false;
    this.loadedData = null;
    this.localIndex = [];
    this.setupMiddleware();
    this.setupRoutes();
  }

    setupMiddleware() {
        this.app.use(cors({
            origin: process.env.NODE_ENV === 'production'
                ? ['https://yourdomain.com']
                : [
                    '*'
                ],
            credentials: true
        }));
        this.app.use(express.json({ limit: '5mb' }));

        this.app.use(express.static(path.join(__dirname, '..', 'public')));
    }

  async tryBuildLinksFromDemo() {
    try {
      const dataDir = path.join(__dirname, 'data');
      const files = await fs.readdir(dataDir);
      const jsons = files.filter(f => f.endsWith('.json')).sort().reverse();
      if (jsons.length === 0) return;
      const raw = await fs.readFile(path.join(dataDir, jsons[0]), 'utf8');
      const data = JSON.parse(raw);
      this.loadedData = data;
      this.ragSystem.buildLinkDatabase(data);
    } catch {}
  }

  setupRoutes() {
    this.app.get('/health', async (req, res) => {
      try {
        const stats = await this.ragSystem.getIndexStats();
        res.json({ status: 'healthy', initialized: this.isInitialized, aiProvider: 'Google Gemini', pineconeIndex: process.env.PINECONE_INDEX_NAME?.trim() || 'Not configured', vectorDatabase: stats, timestamp: new Date().toISOString() });
      } catch (e) {
        res.status(500).json({ status: 'unhealthy', error: e.message });
      }
    });

    this.app.post('/chat', async (req, res) => {
      try {
        const { question } = req.body || {};
        if (!question || !question.trim()) return res.status(400).json({ success: false, error: 'Question is required' });
        if (!this.isInitialized) return res.status(503).json({ success: false, error: 'Server not initialized' });

        // Prefer full chat flow (query + generate)
        try {
          const response = await this.ragSystem.chat(question);
          return res.json({ success: true, aiProvider: 'Google Gemini', question, timestamp: new Date().toISOString(), ...response });
        } catch (e) {
          const emsg = String(e?.message || e);
          const quota = emsg.includes('429') || emsg.toLowerCase().includes('quota');
          if (!quota) throw e;
          // Fallback: keyword retrieval using local demo data if present
          if (!this.localIndex.length) this.buildLocalIndexFromLoaded();
          if (!this.localIndex.length) {
            return res.status(503).json({ success: false, error: 'Embedding quota exceeded and no local demo data available for fallback.' });
          }
          const resp = this.answerLocal(question);
          return res.json({ success: true, mode: 'local-fallback', question, timestamp: new Date().toISOString(), ...resp });
        }
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/stats', async (req, res) => {
      try {
        const stats = await this.ragSystem.getIndexStats();
        res.json({ success: true, statistics: { initialized: this.isInitialized, aiProvider: 'Google Gemini', pineconeIndex: this.ragSystem.indexName || process.env.PINECONE_INDEX_NAME?.trim(), vectorDatabase: stats, timestamp: new Date().toISOString() } });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });

    // Manually embed latest demo data into current index (local embeddings)
    this.app.post('/embed', async (req, res) => {
      try {
        if (!this.isInitialized) return res.status(503).json({ success: false, error: 'Server not initialized' });
        const dataDir = path.join(__dirname, 'data');
        const files = await fs.readdir(dataDir).catch(() => []);
        const jsons = files.filter(f => f.endsWith('.json')).sort().reverse();
        if (!jsons.length) return res.status(404).json({ success: false, error: 'No demo data found in demo/data' });
        const raw = await fs.readFile(path.join(dataDir, jsons[0]), 'utf8');
        const data = JSON.parse(raw);
        await this.ragSystem.processAndStoreDocuments(data);
        const stats = await this.ragSystem.getIndexStats();
        res.json({ success: true, message: 'Embedded latest demo data into current index', latestFile: jsons[0], vectorDatabase: stats });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });

    this.app.get('/links', async (req, res) => {
      try {
        if (!this.isInitialized) return res.status(503).json({ success: false, error: 'Server not initialized' });
        const { type = 'all' } = req.query;
        const allLinks = [];
        for (const [key, link] of this.ragSystem.linkDatabase.entries()) {
          if (type === 'all' || link.type === type) allLinks.push({ key, ...link });
        }
        res.json({ success: true, links: allLinks, totalLinks: allLinks.length, types: [...new Set(allLinks.map(l => l.type))] });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });

    this.app.get('/', (req, res) => {
      // res.json({ name: 'NITJSR Reuse-Only RAG Server', endpoints: ['POST /chat', 'GET /health', 'GET /stats', 'GET /links'] });
      //   res.sendFile(path.join(__dirname, 'public', 'index.html'));
        res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    });
  }

  normalizeText(t) { return (t || '').replace(/\s+/g, ' ').trim(); }
  tokenize(t) { return this.normalizeText(t).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }

  buildLocalIndexFromLoaded() {
    const data = this.loadedData;
    if (!data) return;
    const docs = [];
    for (const page of data.pages || []) {
      const parts = [];
      if (page.title) parts.push(`Title: ${page.title}`);
      parts.push(page.url);
      if (page.headings?.length) parts.push(page.headings.map(h => h.text).join('\n'));
      if (Array.isArray(page.rawContent)) parts.push(page.rawContent.join('\n'));
      else if (page.content) parts.push(page.content);
      const text = this.normalizeText(parts.filter(Boolean).join('\n'));
      docs.push({ url: page.url, title: page.title || page.url, text, category: page.category || 'general' });
    }
    this.localIndex = docs;
  }

  scoreDoc(qTokens, doc) {
    const dtokens = this.tokenize(doc.text);
    if (!dtokens.length) return 0;
    let score = 0;
    for (const qt of qTokens) {
      const matches = dtokens.filter(t => t === qt).length;
      score += matches * 3;
      if (!matches) score += dtokens.some(t => t.includes(qt)) ? 1 : 0;
    }
    return score / Math.sqrt(dtokens.length);
  }

  answerLocal(question) {
    const qTokens = this.tokenize(question);
    const scored = this.localIndex.map(d => ({ d, s: this.scoreDoc(qTokens, d) })).sort((a, b) => b.s - a.s).slice(0, 5);
    const top = scored.filter(x => x.s > 0);
    const sources = top.map(x => ({ url: x.d.url, title: x.d.title, score: x.s, category: x.d.category }));
    const context = top.map(x => `From ${x.d.title} (${x.d.url}):\n${x.d.text.substring(0, 800)}`).join('\n\n');
    return { answer: context || 'No relevant context found.', sources, confidence: sources[0]?.score || 0 };
  }

  validateEnv() {
    const required = ['GEMINI_API_KEY', 'PINECONE_API_KEY', 'PINECONE_INDEX_NAME', 'PINECONE_ENVIRONMENT'];
    const missing = required.filter(k => !process.env[k] || process.env[k].trim() === '');
    if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  async start(port = process.env.DEMO_PORT || 3300) {
    this.server = this.app.listen(port, async () => {
      console.log(`NITJSR Reuse-Only RAG Server on port ${port}`);
      try {
        this.validateEnv();
        await this.ragSystem.initialize();
        // Optional: link metadata for better sources if a demo file exists
        await this.tryBuildLinksFromDemo();
        this.isInitialized = true;
        console.log('Connected to existing Pinecone index and ready.');
      } catch (e) {
        console.error('Initialization error:', e.message);
      }
    });
  }
}

const server = new NITJSRReuseServer();
server.start();

export { NITJSRReuseServer };
