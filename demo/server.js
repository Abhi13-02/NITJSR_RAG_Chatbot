import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { NITJSRScraper } from '../scraper.js';
import { DemoRAGSystem } from './AltRagSystem.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class NITJSRDemoServer {
  constructor() {
    this.app = express();
    this.ragSystem = new DemoRAGSystem();
    this.scraper = new NITJSRScraper({ maxPages: 50, maxDepth: 0, delay: 800 });
    this.isInitialized = false;
    this.fallbackLocal = false;
    this.localIndex = [];
    this.loadedData = null;
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.use(cors({
      origin: process.env.NODE_ENV === 'production'
        ? ['https://yourdomain.com']
        : [
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            'http://localhost:5173',
            'http://127.0.0.1:5173',
            'http://localhost:5500',
            'http://127.0.0.1:5500'
          ],
      credentials: true
    }));
    this.app.use(express.json({ limit: '5mb' }));
  }

  setupRoutes() {
    this.app.get('/health', async (req, res) => {
      try {
        const indexStats = await this.ragSystem.getIndexStats();
        res.json({
          status: 'healthy',
          initialized: this.isInitialized,
          timestamp: new Date().toISOString(),
          aiProvider: 'Google Gemini',
          pineconeIndex: process.env.PINECONE_INDEX_NAME?.trim() || 'Not configured',
          vectorDatabase: indexStats,
        });
      } catch (e) {
        res.status(500).json({ status: 'unhealthy', error: e.message });
      }
    });

    // Initialize system similar to main server, but using demo data
    this.app.post('/initialize', async (req, res) => {
      try {
        const { reuse = false } = req.body || {};
        this.validateEnvironment();

        await this.ragSystem.initialize();

        if (reuse) {
          // Reuse existing vectors in Pinecone; do NOT scrape or embed again.
          // Only load latest local demo data to build link database (optional for nicer link surfacing).
          try {
            const files = await this.listDemoDataFiles();
            if (files.length > 0) {
              const raw = await fs.readFile(files[0].path, 'utf8');
              const data = JSON.parse(raw);
              this.loadedData = data;
              this.ragSystem.buildLinkDatabase(data);
            }
          } catch {}
          this.fallbackLocal = false;
          this.isInitialized = true;
          return res.json({ success: true, message: 'Initialized (reuse existing Pinecone vectors)', reuse: true, aiProvider: 'Google Gemini', pineconeIndex: process.env.PINECONE_INDEX_NAME?.trim(), timestamp: new Date().toISOString() });
        }

        // Default path: load demo data (or scrape) then embed/store
        const latestData = await this.loadLatestDemoDataOrScrape();
        this.loadedData = latestData;

        const reduced = this.reduceDataForEmbedding(latestData);
        try {
          await this.ragSystem.processAndStoreDocuments(reduced);
          this.fallbackLocal = false;
          this.isInitialized = true;
          res.json({ success: true, message: 'Demo RAG system initialized (vector mode)', aiProvider: 'Google Gemini', pineconeIndex: process.env.PINECONE_INDEX_NAME?.trim(), timestamp: new Date().toISOString() });
        } catch (embedErr) {
          // Quota/429 fallback to local retrieval mode
          this.buildLocalIndex(latestData);
          this.fallbackLocal = true;
          this.isInitialized = true;
          res.json({ success: true, message: 'Initialized in local retrieval mode due to embedding limits', mode: 'local-fallback', timestamp: new Date().toISOString(), note: embedErr.message });
        }
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Chat endpoint consistent with main server
    this.app.post('/chat', async (req, res) => {
      try {
        const { question } = req.body;
        if (!question || !question.trim()) {
          return res.status(400).json({ success: false, error: 'Question is required' });
        }
        if (!this.isInitialized) {
          return res.status(503).json({ success: false, error: 'System not initialized. Please call /initialize first.' });
        }

        if (this.fallbackLocal) {
          const response = await this.answerLocal(question);
          res.json({ success: true, mode: 'local-fallback', question, timestamp: new Date().toISOString(), ...response });
        } else {
          const response = await this.ragSystem.chat(question);
          res.json({ success: true, aiProvider: 'Google Gemini', question, timestamp: new Date().toISOString(), ...response });
        }
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Scrape endpoint (selective pages only)
    this.app.post('/scrape', async (req, res) => {
      try {
        const { force = false, includePdf = false } = req.body || {};
        const result = await this.scrapeSelected(includePdf);
        const scrapedData = JSON.parse(await fs.readFile(result.filepath, 'utf8'));
        this.loadedData = scrapedData;

        const reduced = this.reduceDataForEmbedding(scrapedData);
        try {
          if (force) await this.ragSystem.clearIndex();
          await this.ragSystem.processAndStoreDocuments(reduced);
          this.fallbackLocal = false;
          res.json({ success: true, message: 'Selected pages scraped and processed (vector mode)', summary: result.summary, timestamp: new Date().toISOString() });
        } catch (embedErr) {
          this.buildLocalIndex(scrapedData);
          this.fallbackLocal = true;
          res.json({ success: true, message: 'Scraped; embeddings skipped due to limits. Using local retrieval mode.', mode: 'local-fallback', summary: result.summary, note: embedErr.message, timestamp: new Date().toISOString() });
        }
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Stats similar to main server
    this.app.get('/stats', async (req, res) => {
      try {
        const indexStats = await this.ragSystem.getIndexStats();
        const files = await this.listDemoDataFiles();
        res.json({ success: true, statistics: { initialized: this.isInitialized, aiProvider: 'Google Gemini', pineconeIndex: this.ragSystem.indexName || process.env.PINECONE_INDEX_NAME?.trim(), vectorDatabase: indexStats, scrapedDataFiles: files.length, latestDataFile: files[0]?.filename || 'None', timestamp: new Date().toISOString() } });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Sources (reads demo/data)
    this.app.get('/sources', async (req, res) => {
      try {
        const files = await this.listDemoDataFiles();
        const sources = [];
        for (const f of files) {
          try {
            const data = JSON.parse(await fs.readFile(f.path, 'utf8'));
            sources.push({ filename: f.filename, timestamp: data.metadata?.timestamp, pagesScraped: data.pages?.length || 0, pdfsProcessed: data.documents?.pdfs?.length || 0, totalLinks: data.statistics?.totalLinks || 0, pdfLinks: data.links?.pdf?.length || 0, internalLinks: data.links?.internal?.length || 0, version: data.metadata?.scrapeType || 'unknown' });
          } catch {}
        }
        res.json({ success: true, sources });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Links from RAG link database
    this.app.get('/links', async (req, res) => {
      try {
        if (!this.isInitialized) return res.status(503).json({ success: false, error: 'System not initialized' });
        const { type = 'all' } = req.query;
        const allLinks = [];
        for (const [key, link] of this.ragSystem.linkDatabase.entries()) {
          if (type === 'all' || link.type === type) allLinks.push({ key, ...link });
        }
        res.json({ success: true, links: allLinks, totalLinks: allLinks.length, types: [...new Set(allLinks.map(l => l.type))] });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Root
    this.app.get('/', (req, res) => {
      res.json({ name: 'NITJSR Demo RAG Server', endpoints: ['/health', 'POST /initialize', 'POST /chat', 'POST /scrape', '/stats', '/sources', '/links'] });
    });
  }

  validateEnvironment() {
    const required = ['GEMINI_API_KEY', 'PINECONE_API_KEY', 'PINECONE_INDEX_NAME', 'PINECONE_ENVIRONMENT'];
    const missing = required.filter(k => !process.env[k] || process.env[k].trim() === '');
    if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  async listDemoDataFiles() {
    const dataDir = path.join(__dirname, 'data');
    const files = await fs.readdir(dataDir).catch(() => []);
    return files.filter(f => f.endsWith('.json')).map(f => ({ filename: f, path: path.join(dataDir, f) })).sort((a, b) => b.filename.localeCompare(a.filename));
  }

  async loadLatestDemoDataOrScrape() {
    const files = await this.listDemoDataFiles();
    if (files.length > 0) {
      const raw = await fs.readFile(files[0].path, 'utf8');
      return JSON.parse(raw);
    }
    const result = await this.scrapeSelected(false);
    const raw = await fs.readFile(result.filepath, 'utf8');
    return JSON.parse(raw);
  }

  async scrapeSelected(includePdf = false) {
    await this.scraper.initialize();
    try {
      const pagesPath = path.join(__dirname, 'pages.json');
      const urls = JSON.parse(await fs.readFile(pagesPath, 'utf8'));
      for (const url of urls) {
        try { await this.scraper.scrapePage(url, 0); } catch { /* skip */ }
      }
      if (includePdf) await this.scraper.processPDFDocuments();
      this.scraper.updateStatistics();
      const data = this.scraper.scrapedData;
      data.metadata.scrapeType = 'demo_selected';
      const outDir = path.join(__dirname, 'data');
      await fs.mkdir(outDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '_');
      const outPath = path.join(outDir, `nitjsr_demo_${timestamp}.json`);
      await fs.writeFile(outPath, JSON.stringify(data, null, 2), 'utf8');
      const summary = { filename: path.basename(outPath), timestamp: new Date().toISOString(), totalPages: data.statistics.totalPages, totalPDFs: data.statistics.totalPDFs, totalLinks: data.statistics.totalLinks };
      return { summary, filepath: outPath };
    } finally {
      await this.scraper.cleanup();
    }
  }

  // Reduce dataset before embedding to stay under free-tier quotas
  reduceDataForEmbedding(data) {
    const maxPages = parseInt(process.env.DEMO_MAX_PAGES || '5', 10);
    const maxChars = parseInt(process.env.DEMO_MAX_CHARS || '4000', 10);
    const clone = JSON.parse(JSON.stringify(data));
    clone.pages = (clone.pages || []).slice(0, maxPages).map(p => {
      if (p.content && typeof p.content === 'string') p.content = p.content.slice(0, maxChars);
      if (Array.isArray(p.rawContent)) p.rawContent = p.rawContent.join(' ').slice(0, maxChars);
      // Tables and lists can explode chunks; keep small samples
      if (Array.isArray(p.tables)) p.tables = p.tables.slice(0, 1);
      if (Array.isArray(p.lists)) p.lists = p.lists.slice(0, 2);
      return p;
    });
    // Optionally drop PDFs entirely for demo
    if (!process.env.DEMO_INCLUDE_PDF || process.env.DEMO_INCLUDE_PDF === '0') {
      if (!clone.documents) clone.documents = {};
      clone.documents.pdfs = [];
      if (clone.links && clone.links.pdf) clone.links.pdf = [];
    }
    return clone;
  }

  // Local retrieval fallback
  normalizeText(t) { return (t || '').replace(/\s+/g, ' ').trim(); }
  tokenize(t) { return this.normalizeText(t).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }

  buildLocalIndex(data) {
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

  async answerLocal(question) {
    if (!this.localIndex.length && this.loadedData) this.buildLocalIndex(this.loadedData);
    const qTokens = this.tokenize(question);
    const scored = this.localIndex.map(d => ({ d, s: this.scoreDoc(qTokens, d) })).sort((a, b) => b.s - a.s).slice(0, 5);
    const top = scored.filter(x => x.s > 0);
    const sources = top.map(x => ({ url: x.d.url, title: x.d.title, score: x.s, category: x.d.category }));
    const context = top.map(x => `From ${x.d.title} (${x.d.url}):\n${x.d.text.substring(0, 800)}`).join('\n\n');
    return { answer: context || 'No relevant context found.', sources, confidence: sources[0]?.score || 0 };
  }

  async start(port = process.env.DEMO_PORT || 3300) {
    this.server = this.app.listen(port, async () => {
      console.log(`NITJSR Demo RAG Server on port ${port}`);
      // Auto-initialize to match main server behavior
      try {
        await this.ragSystem.initialize();
        const latestData = await this.loadLatestDemoDataOrScrape();
        await this.ragSystem.processAndStoreDocuments(latestData);
        this.isInitialized = true;
        console.log('Demo server initialized with selected pages.');
      } catch (e) {
        console.log('Auto-initialization skipped:', e.message);
      }
    });
  }
}

const server = new NITJSRDemoServer();
server.start();

export { NITJSRDemoServer };
