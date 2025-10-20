import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

import { NITJSRScraper } from './scraper.js';
import { NITJSRRAGSystem } from './RagSystem.js';

class NITJSRServer {
  constructor() {
    this.app = express();
    this.ragSystem = new NITJSRRAGSystem();
    this.scraper = new NITJSRScraper({
      maxPages: 250,
      maxDepth: 4,
      delay: 1000,
    });
    this.isInitialized = false;
    this.setupMiddleware();
    this.setupRoutes();
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
        const response = await this.ragSystem.chat(question);

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

    // Scrape fresh data endpoint
    this.app.post('/scrape', async (req, res) => {
      try {
        const { force = false } = req.body;

        console.log('Starting comprehensive data scrape...');
        const scrapeResult = await this.scraper.scrapeComprehensive();

        // Load and process the scraped data
        const scrapedData = JSON.parse(await fs.readFile(scrapeResult.filepath, 'utf8'));

        // Clear existing data if force flag is set
        if (force) {
          console.log('Clearing existing vector data...');
          await this.ragSystem.clearIndex();
        }

        // Process and store new data
        await this.ragSystem.processAndStoreDocuments(scrapedData);

        res.json({
          success: true,
          message: 'Comprehensive data scraped and processed successfully',
          summary: scrapeResult.summary,
          timestamp: new Date().toISOString(),
          aiProvider: 'Google Gemini',
        });
      } catch (error) {
        console.error('Scrape error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get system statistics
    this.app.get('/stats', async (req, res) => {
      try {
        const indexStats = await this.ragSystem.getIndexStats();

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
              categories: Object.keys(data.categories || {}).map((cat) => ({
                name: cat,
                count: data.categories[cat]?.length || 0,
              })),
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
      // Initialize RAG system
      await this.ragSystem.initialize();

      // Check for existing scraped data
      const dataDir = path.join(__dirname, 'scraped_data');
      let latestData = null;

      try {
        const files = await fs.readdir(dataDir);
        const allFiles = files
          .filter((f) => f.endsWith('.json'))
          .sort()
          .reverse(); // Most recent first

        if (allFiles.length > 0) {
          console.log(`Loading existing data: ${allFiles[0]}`);
          const dataPath = path.join(dataDir, allFiles[0]);
          latestData = JSON.parse(await fs.readFile(dataPath, 'utf8'));
        }
      } catch (error) {
        console.log('No existing data found, will need fresh scrape');
      }

      // If no data exists, perform initial scrape
      if (!latestData) {
        console.log('Performing initial comprehensive data scrape...');
        const scrapeResult = await this.scraper.scrapeComprehensive();
        latestData = JSON.parse(await fs.readFile(scrapeResult.filepath, 'utf8'));
      }

      // Process and store documents
      if (latestData) {
        await this.ragSystem.processAndStoreDocuments(latestData);
      }

      this.isInitialized = true;
      console.log('Gemini RAG system initialization completed successfully!');
    } catch (error) {
      console.error('System initialization failed:', error.message);
      throw error;
    }
  }

  async start(port = process.env.PORT || 3000) {
    try {
      this.server = this.app.listen(port, async () => {
        console.log(`NIT Jamshedpur Gemini RAG Server running on port ${port}`);
        console.log(`AI Provider: Google Gemini`);
        console.log(`Health check: http://localhost:${port}/health`);
        console.log(`Frontend: http://localhost:${port}`);
        console.log(`Statistics: http://localhost:${port}/stats`);
        console.log(`Links: http://localhost:${port}/links`);
        console.log(`Test Gemini: http://localhost:${port}/test-gemini`);
        console.log(`Test Pinecone: http://localhost:${port}/test-pinecone`);

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
    if (this.server) {
      this.server.close(() => {
        console.log('Server shutdown complete');
        process.exit(0);
      });
    }
  }
}

// Start server if this file is run directly
const server = new NITJSRServer();
server.start();

export { NITJSRServer };

