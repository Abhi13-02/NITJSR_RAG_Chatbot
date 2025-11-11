import { authenticateAdmin } from "../config/auth.js";

export function setupHealthRoutes(app, server) {

    // Health check endpoint
    app.get('/health', async (req, res) => {
        try {
            const indexStats = await server.ragSystem.getIndexStats();
            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                initialized: server.isInitialized,
                vectorDatabase: indexStats,
                embeddingCache: server.ragSystem?.embeddingCache?.getStats?.() || null,
                responseCache: server.responseCache?.getStats?.() || null,
                mongo: {
                    status: server.dbManager.mongo.status,
                    db: server.dbManager.mongo.dbName,
                    pagesCollection: server.dbManager.mongo.pagesName,
                    chunksCollection: server.dbManager.mongo.chunksName,
                    lastError: server.dbManager.mongo.lastError,
                },
                environment: process.env.NODE_ENV || 'development',
                aiProvider: 'Google Gemini',
                pineconeIndex: process.env.PINECONE_INDEX_NAME?.trim() || 'Not configured',
            });
        } catch (error) {
            res.status(500).json({ status: 'unhealthy', error: error.message });
        }
    });



    // Test Gemini connection
    app.get('/test-gemini', authenticateAdmin, async (req, res) => {
        try {
            const { GoogleGenerativeAI } = await import('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

            // const models = await genAI.ListModels();
            // console.log(models);

            const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

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
    app.get('/test-pinecone', authenticateAdmin, async (req, res) => {
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
}