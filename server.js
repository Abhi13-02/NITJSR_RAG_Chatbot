import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { MongoClient } from 'mongodb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

import { NITJSRScraper } from './scraper/scraper.js';
import { NITJSRRAGSystem } from './rag-system/RagSystem.js';
import { ResponseCache } from './caching/responseCache.js';

const summarizePageCategories = (pages = []) => {
  const counts = pages.reduce((acc, page) => {
    const key = page?.category || 'general';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).map(([name, count]) => ({ name, count }));
};

class NITJSRServer {
  constructor() {
    this.app = express();
    this.mongo = {
      client: null,
      db: null,
      pagesColl: null,
      chunksColl: null,
      status: 'disconnected',
      lastError: null,
      dbName: null,
      pagesName: null,
      chunksName: null,
    };
    this.ragSystem = new NITJSRRAGSystem({ mongo: this.mongo });
    // Initialize semantic response cache at server level
    try {
      const embedModel = process.env.COHERE_EMBED_MODEL || 'embed-english-v3.0';
      const modelKey = `cohere:${embedModel}:1024`;
      this.responseCache = new ResponseCache({ modelKey });
      const rc = this.responseCache.getStats();
      console.log(`[ResponseCache] initialized backend=${rc.backend} ttlSeconds=${rc.ttlSeconds} bits=${rc.lshBits} radius=${rc.hammingRadius} threshold=${rc.threshold} modelKey=${rc.modelKey}`);
    } catch (_) {}
    this.scraper = new NITJSRScraper({
      maxPages: 4,
      maxDepth: 3,
      delay: 1500,
    });
    this.isInitialized = false;
    this.setupMiddleware();
    this.setupRoutes();
  }

  async connectMongo() {
    if (this.mongo.status === 'connecting') {
      return this.mongo;
    }
    if (this.mongo.status === 'connected' && this.mongo.client) {
      return this.mongo;
    }

    const uri = process.env.MONGODB_URI?.trim();
    if (!uri) {
      this.mongo.status = 'disabled';
      console.warn('[mongo] MONGODB_URI not set; change ledger features disabled.');
      return this.mongo;
    }

    const dbName = (process.env.MONGODB_DB || 'nitjsr_rag').trim();
    const pagesName = (process.env.MONGO_PAGES_COLL || 'pages').trim();
    const chunksName = (process.env.MONGO_CHUNKS_COLL || 'chunks').trim();

    try {
      this.mongo.status = 'connecting';
      this.mongo.client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 7000,
      });
      await this.mongo.client.connect();
      this.mongo.db = this.mongo.client.db(dbName);
      this.mongo.pagesColl = this.mongo.db.collection(pagesName);
      this.mongo.chunksColl = this.mongo.db.collection(chunksName);
      this.mongo.status = 'connected';
      this.mongo.lastError = null;
      this.mongo.dbName = dbName;
      this.mongo.pagesName = pagesName;
      this.mongo.chunksName = chunksName;

      console.log(`[mongo] Connected db=${dbName} pages=${pagesName} chunks=${chunksName}`);
    } catch (error) {
      this.mongo.status = 'error';
      this.mongo.lastError = error?.message || String(error);
      console.error('[mongo] Connection failed:', this.mongo.lastError);
    }

    return this.mongo;
  }

  async ensureMongoConnected() {
    if (this.mongo.status === 'connected') return true;
    await this.connectMongo();
    return this.mongo.status === 'connected';
  }

  async loadLatestScrapedData() {
    const dataDir = path.join(__dirname, 'scraped_data');
    try {
      const files = await fs.readdir(dataDir);
      const latestFile = files
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()[0];
      if (!latestFile) return null;
      const filePath = path.join(dataDir, latestFile);
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
      return { data, filename: latestFile, filepath: filePath };
    } catch (error) {
      return null;
    }
  }

  buildScrapeOptions(payload = {}) {
    if (!payload || typeof payload !== 'object') {
      return {};
    }

    const options = {};
    if (payload.maxPages !== undefined) {
      options.maxPages = payload.maxPages;
    }

    const depthValue = payload.maxDepth ?? payload.depth;
    if (depthValue !== undefined) {
      options.maxDepth = depthValue;
    }

    const priorityValue = payload.priorityUrls ?? payload.priorityUrl;
    if (priorityValue !== undefined) {
      options.priorityUrls = priorityValue;
    }

    const restrictedValue = payload.restrictedUrls ?? payload.restrictedUrl;
    if (restrictedValue !== undefined) {
      options.restrictedUrls = restrictedValue;
    }

    return options;
  }

  setupMiddleware() {
    // CORS configuration
    this.app.use(
      cors({
        origin:
          process.env.NODE_ENV === 'production'
            ? ['https://yourdomain.com']
            : [
                'http://localhost:3000',
                'http://127.0.0.1:3000',
                'http://localhost:5500',
                'http://127.0.0.1:5500',
              ],
        credentials: true,
      })
    );

    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Serve static files
    this.app.use(express.static(path.join(__dirname, 'public')));

    // Request logging middleware
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
      next();
    });

    // Note: error handling middleware is registered after routes in setupRoutes()
  }

  setupRoutes() {
    // Health check endpoint
    this.app.get('/health', async (req, res) => {
      try {
        const indexStats = await this.ragSystem.getIndexStats();
        res.json({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          initialized: this.isInitialized,
          vectorDatabase: indexStats,
          embeddingCache: this.ragSystem?.embeddingCache?.getStats?.() || null,
          responseCache: this.responseCache?.getStats?.() || null,
          mongo: {
            status: this.mongo.status,
            db: this.mongo.dbName,
            pagesCollection: this.mongo.pagesName,
            chunksCollection: this.mongo.chunksName,
            lastError: this.mongo.lastError,
          },
          environment: process.env.NODE_ENV || 'development',
          aiProvider: 'Google Gemini',
          pineconeIndex: process.env.PINECONE_INDEX_NAME?.trim() || 'Not configured',
        });
      } catch (error) {
        res.status(500).json({ status: 'unhealthy', error: error.message });
      }
    });

    // Initialize system endpoint
    this.app.post('/initialize', async (req, res) => {
      try {
        console.log('Starting Gemini RAG system initialization...');

        // Validate environment variables
        this.validateEnvironment();

        await this.initializeSystem();

        res.json({
          success: true,
          message: 'Gemini RAG system initialized successfully',
          timestamp: new Date().toISOString(),
          aiProvider: 'Google Gemini',
          pineconeIndex: process.env.PINECONE_INDEX_NAME?.trim(),
        });
      } catch (error) {
        console.error('Initialization failed:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Embed latest scraped dataset into Pinecone + Mongo ledger
    this.app.post('/embed-latest', async (req, res) => {
      try {
        const mongoReady = await this.ensureMongoConnected();
        if (!mongoReady) {
          return res.status(503).json({
            success: false,
            error: 'MongoDB not connected. Check configuration before embedding.',
          });
        }

        await this.ragSystem.initialize();

        const latestBundle = await this.loadLatestScrapedData();
        if (!latestBundle?.data) {
          return res
            .status(404)
            .json({ success: false, error: 'No scraped data found. Run scraper first.' });
        }

        const result = await this.ragSystem.processAndStoreDocuments(latestBundle.data);
        this.isInitialized = true;

        res.json({
          success: true,
          message: 'Embedded latest scraped dataset successfully.',
          filename: latestBundle.filename,
          runStartedAt: result?.runStartedAt || null,
          stats: result?.stats || null,
          ledger: Boolean(result?.ledger),
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.error('[embed-latest] Failed:', error?.message || error);
        res.status(500).json({
          success: false,
          error: error?.message || 'Failed to embed latest scraped dataset.',
        });
      }
    });

    // Chat endpoint - main RAG functionality
    this.app.post('/chat', async (req, res) => {
      try {
        const { question } = req.body;

        if (!question || question.trim().length === 0) {
          return res
            .status(400)
            .json({ success: false, error: 'Question is required and cannot be empty' });
        }

        if (!this.isInitialized) {
          return res.status(503).json({
            success: false,
            error: 'System not initialized. Please call /initialize first.',
          });
        }

        console.log(`Processing question with Gemini: "${question}"`);
        // Try semantic response cache first (uses ragSystem embedding cache and embeddings)
        try {
          if (this.responseCache && this.ragSystem?.embeddingCache && this.ragSystem?.embeddings) {
            const vector = await this.ragSystem.embeddingCache.getQueryEmbedding(
              question,
              async (q) => await this.ragSystem.embeddings.embedQuery(q)
            );
            const result = await this.responseCache.getSimilar(vector);
            if (result?.hit && result.item?.responseText) {
              console.log(`[ResponseCache] HIT sim=${result.similarity?.toFixed?.(4)} — returning cached answer`);
              const meta = result.item.metadata || {};
              return res.json({
                success: true,
                question,
                timestamp: new Date().toISOString(),
                aiProvider: 'Google Gemini',
                answer: result.item.responseText,
                sources: meta.sources || [],
                relevantLinks: meta.relevantLinks || [],
                confidence: typeof meta.confidence === 'number' ? meta.confidence : 0,
              });
            }
            // On MISS, continue to generate and then store
            var _cacheVector = vector;
          }
        } catch (e) {
          console.warn('[ResponseCache] lookup failed:', e?.message || e);
        }

        const response = await this.ragSystem.chat(question, _cacheVector || null);

        // Store in response cache for future reuse
        try {
          if (this.responseCache && _cacheVector && response?.answer) {
            await this.responseCache.put(_cacheVector, {
              responseText: response.answer,
              question,
              metadata: {
                sources: response.sources || [],
                relevantLinks: response.relevantLinks || [],
                confidence: typeof response.confidence === 'number' ? response.confidence : 0,
              },
            });
          }
        } catch (e) {
          console.warn('[ResponseCache] put failed:', e?.message || e);
        }

        res.json({
          success: true,
          question: question,
          timestamp: new Date().toISOString(),
          aiProvider: 'Google Gemini',
          ...response,
        });
      } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/chat-stream', async (req, res) => {
      const { question } = req.body || {};

      if (!question || question.trim().length === 0) {
        return res
          .status(400)
          .json({ success: false, error: 'Question is required and cannot be empty' });
      }

      if (!this.isInitialized) {
        return res.status(503).json({
          success: false,
          error: 'System not initialized. Please call /initialize first.',
        });
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      const send = (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      let _cacheVector = null;

      try {
        if (this.responseCache && this.ragSystem?.embeddingCache && this.ragSystem?.embeddings) {
          const vector = await this.ragSystem.embeddingCache.getQueryEmbedding(
            question,
            async (q) => await this.ragSystem.embeddings.embedQuery(q)
          );
          _cacheVector = vector;
          const result = await this.responseCache.getSimilar(vector);
          if (result?.hit && result.item?.responseText) {
            console.log(`[ResponseCache] HIT sim=${result.similarity?.toFixed?.(4)} → streaming cached answer`);
            const meta = result.item.metadata || {};
            send('chunk', { text: result.item.responseText });
            send('end', {
              success: true,
              question,
              sources: meta.sources || [],
              relevantLinks: meta.relevantLinks || [],
              confidence: typeof meta.confidence === 'number' ? meta.confidence : 0,
            });
            return res.end();
          }
        }
      } catch (error) {
        console.warn('[ResponseCache] lookup (stream) failed:', error?.message || error);
      }

      try {
        const finalResponse = await this.ragSystem.chatStream(
          question,
          _cacheVector || null,
          (chunkText) => {
            if (chunkText) {
              send('chunk', { text: chunkText });
            }
          }
        );

        try {
          if (this.responseCache && _cacheVector && finalResponse?.answer) {
            await this.responseCache.put(_cacheVector, {
              responseText: finalResponse.answer,
              question,
              metadata: {
                sources: finalResponse.sources || [],
                relevantLinks: finalResponse.relevantLinks || [],
                confidence:
                  typeof finalResponse.confidence === 'number' ? finalResponse.confidence : 0,
              },
            });
          }
        } catch (cacheError) {
          console.warn('[ResponseCache] put (stream) failed:', cacheError?.message || cacheError);
        }

        send('end', {
          success: true,
          question,
          sources: finalResponse?.sources || [],
          relevantLinks: finalResponse?.relevantLinks || [],
          confidence:
            typeof finalResponse?.confidence === 'number' ? finalResponse.confidence : 0,
        });
        res.end();
      } catch (error) {
        console.error('chat-stream error:', error);
        send('error', { error: error?.message || 'Failed to stream response' });
        res.end();
      }
    });

    // Scrape fresh data endpoint
    this.app.post('/scrape', async (req, res) => {
      try {
        const payload = req.body || {};
        const { force = false } = payload;
        const scrapeOptions = this.buildScrapeOptions(payload);
        const hasOverrides = Object.keys(scrapeOptions).length > 0;

        console.log('Starting comprehensive data scrape...');
        if (hasOverrides) {
          console.log('[scrape] Runtime overrides:', scrapeOptions);
        }
        const scrapeResult = await this.scraper.scrapeComprehensive(scrapeOptions);

        // Load and process the scraped data
        const scrapedData = JSON.parse(await fs.readFile(scrapeResult.filepath, 'utf8'));

        // Clear existing data if force flag is set
        if (force) {
          console.log('Clearing existing vector data...');
          await this.ragSystem.clearIndex();
        }

        await this.ensureMongoConnected();

        // Process and store new data
        //await this.ragSystem.processAndStoreDocuments(scrapedData);

        res.json({
          success: true,
          message: 'Comprehensive data scraped and processed successfully',
          summary: scrapeResult.summary,
          options: scrapeOptions,
          timestamp: new Date().toISOString(),
          aiProvider: 'Google Gemini',
        });
      } catch (error) {
        console.error('Scrape error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Combined scrape and embed endpoint
    this.app.post('/scrape-and-embed', async (req, res) => {
      try {
        const payload = req.body || {};
        const { force = false } = payload;
        const scrapeOptions = this.buildScrapeOptions(payload);
        const hasOverrides = Object.keys(scrapeOptions).length > 0;

        console.log('[scrape-and-embed] Starting combined scrape + embed...');
        if (hasOverrides) {
          console.log('[scrape-and-embed] Runtime overrides:', scrapeOptions);
        }
        const scrapeResult = await this.scraper.scrapeComprehensive(scrapeOptions);
        console.log('[scrape-and-embed] Scrape completed:', scrapeResult?.summary || 'No summary available');

        const scrapedData = JSON.parse(await fs.readFile(scrapeResult.filepath, 'utf8'));

        // Build a brief summary for logs/response
        const brief = {
          pagesScraped: scrapedData.pages?.length || 0,
          pdfsProcessed: scrapedData.documents?.pdfs?.length || 0,
          totalLinks: scrapedData.statistics?.totalLinks || 0,
          pdfLinks: scrapedData.links?.pdf?.length || 0,
          internalLinks: scrapedData.links?.internal?.length || 0,
          categories: summarizePageCategories(scrapedData.pages || []),
          timestamp: scrapedData.metadata?.timestamp || new Date().toISOString(),
          scrapeType: scrapedData.metadata?.scrapeType || 'unknown',
          filename: path.basename(scrapeResult.filepath),
        };
        console.log('[scrape-and-embed] Summary:', {
          pagesScraped: brief.pagesScraped,
          pdfsProcessed: brief.pdfsProcessed,
          totalLinks: brief.totalLinks,
          categories: brief.categories?.length || 0,
          file: brief.filename,
        });

        if (force) {
          console.log('[scrape-and-embed] Force flag set — clearing existing vector index...');
          await this.ragSystem.clearIndex();
        }

        // await this.ensureMongoConnected();
        await this.ragSystem.initialize();

        console.log('[scrape-and-embed] Embedding scraped data into vector store...');
        const embedResult = await this.ragSystem.processAndStoreDocuments(scrapedData);
        console.log('[scrape-and-embed] Embedding completed:', embedResult?.stats || 'No stats available');

        this.isInitialized = true;

        res.json({
          success: true,
          message: 'Comprehensive data scraped and embedded successfully',
          timestamp: new Date().toISOString(),
          aiProvider: 'Google Gemini',
          options: scrapeOptions,
          scrape: {
            summary: scrapeResult.summary,
            brief,
          },
          embed: {
            runStartedAt: embedResult?.runStartedAt || null,
            stats: embedResult?.stats || null,
            ledger: Boolean(embedResult?.ledger),
          },
        });
      } catch (error) {
        console.error('[scrape-and-embed] Error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Admin: reset vector store (Pinecone) + Mongo collections
    this.app.post('/reset-storage', async (req, res) => {
      try {
        // make sure RAG system is ready so clearIndex() has an index
        await this.ragSystem.initialize();

        console.log('[reset-storage] Clearing Pinecone index...');
        await this.ragSystem.clearIndex(); // this calls index.deleteAll() and clears link DB
        console.log('[reset-storage] Pinecone cleared.');

        // clear Mongo, if connected
        const mongoReady = await this.ensureMongoConnected();
        if (mongoReady && this.mongo.pagesColl && this.mongo.chunksColl) {
          console.log('[reset-storage] Clearing Mongo pages/chunks...');
          await this.mongo.pagesColl.deleteMany({});
          await this.mongo.chunksColl.deleteMany({});
          console.log('[reset-storage] Mongo collections cleared.');
        }

        // since we just wiped everything, mark server as not initialized
        this.isInitialized = false;

        // optionally clear response cache if the class has it
        if (this.responseCache && typeof this.responseCache.clear === 'function') {
          this.responseCache.clear();
        }

        res.json({
          success: true,
          message: 'Pinecone index and Mongo collections cleared. You can now scrape/embed fresh.',
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.error('[reset-storage] Failed:', error);
        res.status(500).json({
          success: false,
          error: error?.message || 'Failed to reset storage',
        });
      }
    });

    // Get system statistics
    this.app.get('/stats', async (req, res) => {
      try {
        const indexStats = await this.ragSystem.getIndexStats();
        const mongoSummary = {
          status: this.mongo.status,
          db: this.mongo.dbName,
          pagesCollection: this.mongo.pagesName,
          chunksCollection: this.mongo.chunksName,
          lastError: this.mongo.lastError,
          totals: null,
        };

        if (this.mongo.status === 'connected' && this.mongo.pagesColl && this.mongo.chunksColl) {
          try {
            const [pagesTotal, pagesActive, chunksTotal] = await Promise.all([
              this.mongo.pagesColl.estimatedDocumentCount(),
              this.mongo.pagesColl.countDocuments({ deleted: false }),
              this.mongo.chunksColl.estimatedDocumentCount(),
            ]);
            mongoSummary.totals = {
              pages: pagesTotal,
              pagesActive,
              chunks: chunksTotal,
            };
          } catch (mongoErr) {
            mongoSummary.lastError = mongoErr?.message || String(mongoErr);
            mongoSummary.status = 'error';
          }
        }

        // Get available scraped data files
        const dataDir = path.join(__dirname, 'scraped_data');
        let dataFiles = [];
        try {
          const files = await fs.readdir(dataDir);
          dataFiles = files
            .filter((f) => f.endsWith('.json'))
            .map((f) => ({ filename: f, path: path.join(dataDir, f) }))
            .sort((a, b) => b.filename.localeCompare(a.filename)); // Most recent first
        } catch (error) {
          // Directory doesn't exist yet
        }

        res.json({
          success: true,
          statistics: {
            initialized: this.isInitialized,
            aiProvider: 'Google Gemini',
            pineconeIndex: process.env.PINECONE_INDEX_NAME?.trim(),
            pineconeEnvironment: process.env.PINECONE_ENVIRONMENT?.trim(),
            vectorDatabase: indexStats,
            embeddingCache: this.ragSystem?.embeddingCache?.getStats?.() || null,
            mongo: mongoSummary,
            scrapedDataFiles: dataFiles.length,
            latestDataFile: dataFiles[0]?.filename || 'None',
            serverUptime: process.uptime(),
            nodeVersion: process.version,
            timestamp: new Date().toISOString(),
          },
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Preview diff without embedding
    this.app.get('/reindex/preview', async (req, res) => {
      try {
        const mongoReady = await this.ensureMongoConnected();
        if (!mongoReady) {
          return res.status(503).json({
            success: false,
            error: 'MongoDB not connected; preview unavailable',
            mongo: { status: this.mongo.status, lastError: this.mongo.lastError },
          });
        }

        const latest = await this.loadLatestScrapedData();
        if (!latest) {
          return res.status(404).json({
            success: false,
            error: 'No scraped datasets found. Run a scrape first.',
          });
        }

        const preview = await this.ragSystem.previewIngestion(latest.data);
        res.json({
          success: true,
          timestamp: new Date().toISOString(),
          sourceFile: latest.filename,
          preview,
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get data sources with link information
    this.app.get('/sources', async (req, res) => {
      try {
        const dataDir = path.join(__dirname, 'scraped_data');
        const files = await fs.readdir(dataDir).catch(() => []);

        const sources = [];
        for (const file of files.filter((f) => f.endsWith('.json'))) {
          try {
            const filePath = path.join(dataDir, file);
            const data = JSON.parse(await fs.readFile(filePath, 'utf8'));

            sources.push({
              filename: file,
              timestamp: data.metadata?.timestamp,
              pagesScraped: data.pages?.length || 0,
              pdfsProcessed: data.documents?.pdfs?.length || 0,
              totalLinks: data.statistics?.totalLinks || 0,
              pdfLinks: data.links?.pdf?.length || 0,
              internalLinks: data.links?.internal?.length || 0,
              categories: summarizePageCategories(data.pages || []),
              version: data.metadata?.scrapeType || 'unknown',
            });
          } catch (error) {
            console.error(`Error reading ${file}:`, error.message);
          }
        }

        res.json({
          success: true,
          sources: sources.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get available links endpoint
    this.app.get('/links', async (req, res) => {
      try {
        const { type = 'all' } = req.query;

        if (!this.isInitialized) {
          return res.status(503).json({ success: false, error: 'System not initialized' });
        }

        const allLinks = [];
        for (const [key, link] of this.ragSystem.linkDatabase.entries()) {
          if (type === 'all' || link.type === type) {
            allLinks.push({ key: key, ...link });
          }
        }

        res.json({
          success: true,
          links: allLinks,
          totalLinks: allLinks.length,
          types: [...new Set(allLinks.map((link) => link.type))],
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Test Gemini connection
    this.app.get('/test-gemini', async (req, res) => {
      try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

        const result = await model.generateContent(
          'Say hello and confirm you are working correctly.'
        );
        const response = result.response.text();

        res.json({
          success: true,
          message: 'Gemini connection successful',
          response: response,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, error: 'Gemini connection failed: ' + error.message });
      }
    });

    // Test Pinecone connection
    this.app.get('/test-pinecone', async (req, res) => {
      try {
        const { Pinecone } = await import('@pinecone-database/pinecone');
        const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY.trim() });

        const indexList = await pinecone.listIndexes();
        const targetIndex = process.env.PINECONE_INDEX_NAME?.trim();
        const indexExists = indexList.indexes?.some((index) => index.name === targetIndex);

        res.json({
          success: true,
          message: 'Pinecone connection successful',
          targetIndex: targetIndex,
          indexExists: indexExists,
          availableIndexes: indexList.indexes?.map((i) => i.name) || [],
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, error: 'Pinecone connection failed: ' + error.message });
      }
    });

    // Root endpoint
    this.app.get('/admin', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    });

    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({ success: false, error: 'Endpoint not found' });
    });

    // Error handling middleware (must be after routes)
    this.app.use((error, req, res, next) => {
      console.error('Server error:', error);
      res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
      });
    });
  }

  validateEnvironment() {
    const required = [
      'GEMINI_API_KEY',
      'COHERE_API_KEY',
      'PINECONE_API_KEY',
      'PINECONE_INDEX_NAME',
      'PINECONE_ENVIRONMENT',
    ];
    const missing = required.filter((key) => !process.env[key] || process.env[key].trim() === '');

    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    console.log('Environment variables validated');
    console.log(`Using Pinecone index: ${process.env.PINECONE_INDEX_NAME.trim()}`);
    console.log(`Pinecone environment: ${process.env.PINECONE_ENVIRONMENT.trim()}`);
  }

  async initializeSystem() {
    if (this.isInitialized) {
      console.log('System already initialized');
      return;
    }

    try {
      const mongoReady = await this.ensureMongoConnected();
      if (!mongoReady) {
        console.warn('[init] MongoDB not connected; change ledger features will be skipped this run.');
      }

      // Initialize RAG system (clients, models, index handle)
      await this.ragSystem.initialize();

      // Decide whether to (re)embed on init
      // const skipReembedEnv = (process.env.INIT_SKIP_EMBED_IF_INDEX_NOT_EMPTY || 'true').toLowerCase() !== 'false';
      // let shouldEmbedOnInit = true;
      // try {
      //   const stats = await this.ragSystem.getIndexStats();
      //   if (skipReembedEnv && stats && stats.totalVectors && stats.totalVectors > 0) {
      //     console.log(`[init] Skipping re-embedding on initialize: index already has ${stats.totalVectors} vectors`);
      //     shouldEmbedOnInit = false;
      //   }
      // } catch (e) {
      //   console.log('[init] Could not check index stats, proceeding with default initialization path');
      // }

      // if (shouldEmbedOnInit) {
      //   // Check for existing scraped data
      //   let latestDataBundle = await this.loadLatestScrapedData();
      //   let latestData = latestDataBundle?.data;

      //   // If no data exists, perform initial scrape
      //   if (!latestData) {
      //     console.log('Performing initial comprehensive data scrape...');
      //     const scrapeResult = await this.scraper.scrapeComprehensive();
      //     latestData = JSON.parse(await fs.readFile(scrapeResult.filepath, 'utf8'));
      //   }

      //   // Process and store documents
      //   if (latestData) {
      //     await this.ragSystem.processAndStoreDocuments(latestData);
      //   }
      // }

      this.isInitialized = true;
      console.log('Gemini RAG system initialization completed successfully!');
    } catch (error) {
      console.error('System initialization failed:', error.message);
      throw error;
    }
  }

  async start(port = process.env.PORT || 3000) {
    try {
      await this.connectMongo();
      this.server = this.app.listen(port, async () => {
        console.log(`NIT Jamshedpur Gemini RAG Server running on port ${port}`);
        console.log(`AI Provider: Google Gemini`);
        console.log(`Health check: http://localhost:${port}/health`);
        console.log(`Frontend: http://localhost:${port}`);
        console.log(`Statistics: http://localhost:${port}/stats`);
        console.log(`Links: http://localhost:${port}/links`);
        console.log(`Test Gemini: http://localhost:${port}/test-gemini`);
        console.log(`Test Pinecone: http://localhost:${port}/test-pinecone`);
        console.log(`check changes: http://localhost:${port}/reindex/preview`);
        console.log(`embed latest data: POST http://localhost:${port}/embed-latest`);

        // Auto-initialize on startup (configurable)
        const shouldAutoInit = (process.env.AUTO_INIT || 'true').toLowerCase() !== 'false';
        if (shouldAutoInit) {
          try {
            console.log('Auto-initializing Gemini RAG system...');
            await this.initializeSystem();
            console.log('Server fully operational with Gemini AI!');
          } catch (error) {
            console.error('Auto-initialization failed:', error.message);
            console.log('Manual initialization: POST /initialize');
            console.log('Test connections: GET /test-gemini and GET /test-pinecone');
          }
        } else {
          console.log('Auto-initialization disabled. Initialize manually via POST /initialize');
        }
      });

      // Graceful shutdown
      process.on('SIGTERM', () => this.shutdown());
      process.on('SIGINT', () => this.shutdown());
    } catch (error) {
      console.error('Server startup failed:', error.message);
      process.exit(1);
    }
  }

  async shutdown() {
    console.log('Shutting down server...');
    if (this.mongo?.client) {
      try {
        await this.mongo.client.close();
        console.log('[mongo] connection closed');
      } catch (error) {
        console.warn('[mongo] error during shutdown:', error?.message || error);
      } finally {
        this.mongo.client = null;
        this.mongo.db = null;
        this.mongo.pagesColl = null;
        this.mongo.chunksColl = null;
        this.mongo.status = 'disconnected';
      }
    }
    if (this.server) {
      this.server.close(() => {
        console.log('Server shutdown complete');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  }
}

// Start server if this file is run directly
const server = new NITJSRServer();
server.start();

export { NITJSRServer };

