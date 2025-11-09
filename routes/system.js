export function setupSystemRoutes(app, server) {

    // Initialize system endpoint
    app.post('/initialize', async (req, res) => {
        try {
            console.log('Starting Gemini RAG system initialization...');

            // Validate environment variables
            server.validateEnvironment();

            await server.initializeSystem();

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
    app.post('/embed-latest', async (req, res) => {
        try {
            const mongoReady = await server.dbManager.ensureMongoConnected();
            if (!mongoReady) {
                return res.status(503).json({
                    success: false,
                    error: 'MongoDB not connected. Check configuration before embedding.',
                });
            }

            await server.ragSystem.initialize();

            const latestBundle = await server.loadLatestScrapedData();
            if (!latestBundle?.data) {
                return res
                    .status(404)
                    .json({ success: false, error: 'No scraped data found. Run scraper first.' });
            }

            const result = await server.ragSystem.processAndStoreDocuments(latestBundle.data);
            server.isInitialized = true;

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



    // Admin: reset vector store (Pinecone) + Mongo collections
    app.post('/reset-storage', async (req, res) => {
        try {
            // make sure RAG system is ready so clearIndex() has an index
            await server.ragSystem.initialize();

            console.log('[reset-storage] Clearing Pinecone index...');
            await server.ragSystem.clearIndex();
            console.log('[reset-storage] Pinecone cleared.');

            // clear Mongo, if connected
            const mongoReady = await server.dbManager.ensureMongoConnected();
            if (mongoReady && server.dbManager.mongo.pagesColl && server.dbManager.mongo.chunksColl) {
                console.log('[reset-storage] Clearing Mongo pages/chunks...');
                await server.dbManager.mongo.pagesColl.deleteMany({});
                await server.dbManager.mongo.chunksColl.deleteMany({});
                console.log('[reset-storage] Mongo collections cleared.');
            }

            // since we just wiped everything, mark server as not initialized
            server.isInitialized = false;

            // optionally clear response cache if the class has it
            if (server.responseCache && typeof server.responseCache.clear === 'function') {
                server.responseCache.clear();
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



    // Preview diff without embedding
    app.get('/reindex/preview', async (req, res) => {
        try {
            const mongoReady = await server.dbManager.ensureMongoConnected();
            if (!mongoReady) {
                return res.status(503).json({
                    success: false,
                    error: 'MongoDB not connected; preview unavailable',
                    mongo: {
                        status: server.dbManager.mongo.status,
                        lastError: server.dbManager.mongo.lastError
                    },
                });
            }

            const latest = await server.loadLatestScrapedData();
            if (!latest) {
                return res.status(404).json({
                    success: false,
                    error: 'No scraped datasets found. Run a scrape first.',
                });
            }

            const preview = await server.ragSystem.previewIngestion(latest.data);
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

}