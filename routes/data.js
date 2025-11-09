import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


const summarizePageCategories = (pages = []) => {
    const counts = pages.reduce((acc, page) => {
        const key = page?.category || 'general';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    return Object.entries(counts).map(([name, count]) => ({ name, count }));
};


export function setupDataRoutes(app, server) {

    // Get system statistics
    app.get('/stats', async (req, res) => {
        try {
            const indexStats = await server.ragSystem.getIndexStats();
            const mongoSummary = {
                status: server.dbManager.mongo.status,
                db: server.dbManager.mongo.dbName,
                pagesCollection: server.dbManager.mongo.pagesName,
                chunksCollection: server.dbManager.mongo.chunksName,
                lastError: server.dbManager.mongo.lastError,
                totals: null,
            };

            if (
                server.dbManager.mongo.status === 'connected' &&
                server.dbManager.mongo.pagesColl &&
                server.dbManager.mongo.chunksColl
            ) {
                try {
                    const [pagesTotal, pagesActive, chunksTotal] = await Promise.all([
                        server.dbManager.mongo.pagesColl.estimatedDocumentCount(),
                        server.dbManager.mongo.pagesColl.countDocuments({ deleted: false }),
                        server.dbManager.mongo.chunksColl.estimatedDocumentCount(),
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
            const dataDir = path.join(dirname(__dirname), 'scraped_data');
            let dataFiles = [];
            try {
                const files = await fs.readdir(dataDir);
                dataFiles = files
                    .filter((f) => f.endsWith('.json'))
                    .map((f) => ({ filename: f, path: path.join(dataDir, f) }))
                    .sort((a, b) => b.filename.localeCompare(a.filename));
            } catch (error) {
                // Directory doesn't exist yet
            }

            res.json({
                success: true,
                statistics: {
                    initialized: server.isInitialized,
                    aiProvider: 'Google Gemini',
                    pineconeIndex: process.env.PINECONE_INDEX_NAME?.trim(),
                    pineconeEnvironment: process.env.PINECONE_ENVIRONMENT?.trim(),
                    vectorDatabase: indexStats,
                    embeddingCache: server.ragSystem?.embeddingCache?.getStats?.() || null,
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



    // Get data sources with link information
    app.get('/sources', async (req, res) => {
        try {
            const dataDir = path.join(dirname(__dirname), 'scraped_data');
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
    app.get('/links', async (req, res) => {
        try {
            const { type = 'all' } = req.query;

            if (!server.isInitialized) {
                return res.status(503).json({ success: false, error: 'System not initialized' });
            }

            const allLinks = [];
            for (const [key, link] of server.ragSystem.linkDatabase.entries()) {
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

}