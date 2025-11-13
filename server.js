import dotenv from 'dotenv';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { setupAuthRoutes } from './routes/auth.js';
import { NITJSRRAGSystem } from './rag-system/RagSystem.js';
import { ResponseCache } from './caching/responseCache.js';
import { ChatHistory } from './caching/chatHistory.js';
import { DatabaseManager } from './config/db.js';
import { setupMiddleware, setupErrorHandler } from './config/middleware.js';
import { setupRoutes } from './routes/index.js';
import { buildScrapeOptions, loadLatestScrapedData, validateEnvironment } from './utils/helpers.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();


class NITJSRServer {
    constructor() {
        this.app = express();
        this.__dirname = __dirname;

        // Initialize database manager
        this.dbManager = new DatabaseManager();

        // Initialize RAG system with database reference
        this.ragSystem = new NITJSRRAGSystem({ mongo: this.dbManager.mongo });

        // Initialize semantic response cache
        try {
            const embedModel = process.env.COHERE_EMBED_MODEL || 'embed-english-v3.0';
            const modelKey = `cohere:${embedModel}:1024`;
            this.responseCache = new ResponseCache({ modelKey });
            const rc = this.responseCache.getStats();
            console.log(
                `[ResponseCache] initialized backend=${rc.backend} ttlSeconds=${rc.ttlSeconds} bits=${rc.lshBits} radius=${rc.hammingRadius} threshold=${rc.threshold} modelKey=${rc.modelKey}`
            );
        } catch (_) {}

        // Initialize chat history
        try {
            this.chatHistory = new ChatHistory();
            console.log(
                `[ChatHistory] initialized backend=${this.chatHistory.backend} limit=${this.chatHistory.perSessionLimit} namespace=${this.chatHistory.namespace}`
            );
        } catch (error) {
            this.chatHistory = null;
            console.warn('[ChatHistory] initialization failed:', error?.message || error);
        }

        // Scraper is optional and only loaded when enabled
        this.scraper = null;
        this.scraperEnabled = (process.env.ENABLE_SCRAPER || '').toLowerCase() === 'true';

        this.isInitialized = false;
        this._chatRateLimiter = null;

        // Setup middleware and routes
        setupMiddleware(this.app, this.__dirname);
        setupAuthRoutes(this.app);
        setupRoutes(this.app, this);
        setupErrorHandler(this.app);
    }

    // Helper methods
    buildScrapeOptions(payload) {
        return buildScrapeOptions(payload);
    }

    async loadLatestScrapedData() {
        return loadLatestScrapedData(this.__dirname);
    }

    validateEnvironment() {
        return validateEnvironment();
    }

    async ensureScraper() {
        if (!this.scraperEnabled) {
            throw new Error('Scraper is disabled');
        }
        if (this.scraper) {
            return this.scraper;
        }
        const { NITJSRScraper } = await import('./scraper/scraper.js');
        const defaultDelay = Number(process.env.SCRAPE_DELAY) || 1500;
        const defaultMaxPages = Number(process.env.SCRAPE_MAX_PAGES) || 650;
        const defaultMaxDepth = Number(process.env.SCRAPE_MAX_DEPTH) || 3;
        this.scraper = new NITJSRScraper({
            maxPages: defaultMaxPages,
            maxDepth: defaultMaxDepth,
            delay: defaultDelay,
        });
        return this.scraper;
    }


    async initializeSystem() {
        if (this.isInitialized) {
            console.log('System already initialized');
            return;
        }

        try {
            const mongoReady = await this.dbManager.ensureMongoConnected();
            if (!mongoReady) {
                console.warn(
                    '[init] MongoDB not connected; change ledger features will be skipped this run.'
                );
            }

            // Initialize RAG system (clients, models, index handle)
            await this.ragSystem.initialize();

            this.isInitialized = true;
            console.log('Gemini RAG system initialization completed successfully!');
        } catch (error) {
            console.error('System initialization failed:', error.message);
            throw error;
        }
    }


    async start(port = process.env.PORT || 3000) {
        try {
            await this.dbManager.connectMongo();
            this.server = this.app.listen(port, async () => {
                console.log(`Server listening on port ${port}`);
                console.log('AI Provider: Google Gemini');

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
        await this.dbManager.closeMongo();
        await this.dbManager.closeRedis();

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
