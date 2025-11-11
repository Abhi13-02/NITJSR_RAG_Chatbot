import { MongoClient } from 'mongodb';
import { createClient as createRedisClient } from 'redis';

export class DatabaseManager {
    constructor() {
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
        this.redis = null;
    }


    async connectRedis() {
        if (this.redis) return this.redis;

        const url = process.env.REDIS_URL;
        if (!url) {
            console.warn('[redis] REDIS_URL not set; rate limiting will use memory fallback.');
            return null;
        }

        const client = createRedisClient({ url });
        client.on('error', (err) => {
            console.warn('[redis] client error:', err?.message || err);
        });

        await client.connect();
        console.log('[redis] connected for rate limiting');
        this.redis = client;
        return this.redis;
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



    async closeMongo() {
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
    }



    async closeRedis() {
        if (this.redis) {
            try {
                await this.redis.quit();
                console.log('[redis] connection closed');
            } catch (error) {
                console.warn('[redis] error during shutdown:', error?.message || error);
            } finally {
                this.redis = null;
            }
        }
    }

}