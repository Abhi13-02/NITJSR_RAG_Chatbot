import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Pinecone } from '@pinecone-database/pinecone';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { CohereEmbeddings } from '@langchain/cohere';
import { EmbeddingCache } from './caching/embeddingCache.js';
import crypto from 'crypto';

dotenv.config();

const hashString = (input) =>
    crypto.createHash('sha256').update(input || '', 'utf8').digest('hex');

const makeChunkId = (url, index, textHash) => {
    const urlHash = hashString(url).slice(0, 12);
    const chunkIndex = String(index).padStart(4, '0');
    const textHashShort = (textHash || '').slice(0, 10);
    return `${urlHash}:${chunkIndex}:${textHashShort}`;
};

const nowIso = () => new Date().toISOString();

const countWords = (text) =>
    (text || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;

const collectXhrTextFragments = (value, path = [], acc = [], depth = 0) => {
    if (value === null || value === undefined) return acc;
    if (depth > 6) return acc;

    if (typeof value === 'string') {
        const cleaned = value.replace(/\s+/g, ' ').trim();
        if (!cleaned) return acc;
        const alphaChars = (cleaned.match(/[a-zA-Z]/g) || []).length;
        const minAlpha = Math.min(6, Math.ceil(cleaned.length * 0.2));
        if (alphaChars < minAlpha) return acc;
        const truncated = cleaned.length > 400 ? `${cleaned.slice(0, 400)}...` : cleaned;
        const label = path.length ? path.join(' > ') : '';
        acc.push(label ? `${label}: ${truncated}` : truncated);
        return acc;
    }

    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return acc;
    }

    if (Array.isArray(value)) {
        if (value.length > 50) return acc;
        value.forEach((item, idx) => collectXhrTextFragments(item, path.concat(`#${idx + 1}`), acc, depth + 1));
        return acc;
    }

    if (typeof value === 'object') {
        const entries = Object.entries(value || {}).slice(0, 50);
        entries.forEach(([key, val]) => collectXhrTextFragments(val, path.concat(key), acc, depth + 1));
    }

    return acc;
};

const stringifyXhrData = (data) => {
    const fragments = collectXhrTextFragments(data, [], [], 0);
    if (!fragments.length) return '';
    return fragments.slice(0, 60).join('\n');
};

const extractTextFromXhrResponses = (responses = []) => {
    if (!Array.isArray(responses) || !responses.length) return '';
    const sections = [];
    responses.forEach((response, index) => {
        if (!response || typeof response !== 'object') return;
        const dataText = stringifyXhrData(response.data);
        if (!dataText) return;
        const parts = [];
        if (response.url) parts.push(response.url);
        if (response.status !== undefined) parts.push(`status ${response.status}`);
        if (response.timestamp) parts.push(response.timestamp);
        const headerSuffix = parts.length ? ` (${parts.join(' | ')})` : '';
        sections.push(`XHR ${index + 1}${headerSuffix}\n${dataText}`);
    });
    return sections.join('\n\n');
};

const tableToLines = (table) => {
    if (!table) return [];
    if (Array.isArray(table)) {
        return table
            .filter(row => Array.isArray(row))
            .map(row => row.map(cell => (cell ?? '')).join(' | ').trim())
            .filter(Boolean);
    }
    if (typeof table === 'object') {
        const lines = [];
        if (Array.isArray(table.headers) && table.headers.length) {
            const headerLine = table.headers.map(cell => cell ?? '').join(' | ').trim();
            if (headerLine) lines.push(headerLine);
        }
        if (Array.isArray(table.rows)) {
            table.rows.forEach(row => {
                if (!Array.isArray(row)) return;
                const line = row.map(cell => (cell ?? '')).join(' | ').trim();
                if (line) lines.push(line);
            });
        }
        return lines;
    }
    return [];
};

const flattenTablesToText = (tables = []) => {
    if (!Array.isArray(tables) || !tables.length) return '';
    const blocks = tables
        .map(table => tableToLines(table).join('\n'))
        .filter(Boolean);
    return blocks.join('\n\n');
};

class NITJSRRAGSystem {
    constructor(options = {}) {
        const { mongo = null } = options || {};
        this.genAI = null;
        this.pinecone = null;
        this.index = null;
        this.embeddings = null;
        this.chatModel = null;
        this.textSplitter = null;
        this.isInitialized = false;
        this.linkDatabase = new Map(); // Store links for easy retrieval
        this.embeddingCache = new EmbeddingCache();
        this.mongo = mongo;
        this.pagesColl = mongo?.pagesColl || null;
        this.chunksColl = mongo?.chunksColl || null;
        this._mongoIndexesEnsured = false;
        this._lastLedgerWarning = 0;
        try {
            const ec = this.embeddingCache.getStats();
            console.log(`[EmbeddingCache] initialized backend=${ec.backend} ttlSeconds=${ec.ttlSeconds} namespace=${ec.namespace}`);
        } catch (_) {}
    }

    refreshMongoHandles() {
        if (this.mongo?.pagesColl && this.mongo?.chunksColl) {
            this.pagesColl = this.mongo.pagesColl;
            this.chunksColl = this.mongo.chunksColl;
        }
    }

    mongoAvailable() {
        this.refreshMongoHandles();
        return Boolean(this.pagesColl && this.chunksColl);
    }

    async initialize() {
        if (this.isInitialized) return;

        console.log('🚀 Initializing Gemini(chat) + Cohere(emb) + Pinecone...');

        try {
            // Initialize Google Gemini
            this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            this.chatModel = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

            // Initialize Pinecone
            this.pinecone = new Pinecone({
                apiKey: process.env.PINECONE_API_KEY.trim(),
            });

            // Get or create index
            await this.initializePineconeIndex();

            // Optional: verify index dimension to match Cohere embeddings (1024)
            try {
                const stats = await this.index.describeIndexStats();
                if (stats?.dimension && stats.dimension !== 1024) {
                    console.warn(`Pinecone index '${process.env.PINECONE_INDEX_NAME.trim()}' has dimension ${stats.dimension}, but Cohere embeddings require 1024.`);
                    console.warn('Please recreate the index with dimension 1024 to proceed.');
                }
            } catch (e) {
                console.warn('Could not read Pinecone index stats:', e?.message || e);
            }

            // Initialize embeddings using Cohere
            this.embeddings = new CohereEmbeddings({
                apiKey: process.env.COHERE_API_KEY,
                model: process.env.COHERE_EMBED_MODEL || 'embed-english-v3.0',
                inputType: 'search_document',
            });

            this.textSplitter = new RecursiveCharacterTextSplitter({
                chunkSize: 1200, // Increased chunk size for better context
                chunkOverlap: 300, // Increased overlap
                separators: ['\n\n', '\n', '. ', '! ', '? ', ' ', ''],
            });

            await this.ensureMongoIndexes();
            this.isInitialized = true;
            console.log('✅ Gemini RAG System initialized successfully!');

        } catch (error) {
            console.error('❌ RAG System initialization failed:', error.message);
            throw error;
        }
    }

    async initializePineconeIndex() {
        const indexName = process.env.PINECONE_INDEX_NAME.trim();

        try {
            // Check if index exists
            const indexList = await this.pinecone.listIndexes();
            const indexExists = indexList.indexes?.some(index => index.name === indexName);

            if (!indexExists) {
                console.log(`🔨 Creating new Pinecone index: ${indexName}`);
                await this.pinecone.createIndex({
                    name: indexName,
                    dimension: 1024, // Cohere v3 embedding dimension
                    metric: 'cosine',
                    spec: {
                        serverless: {
                            cloud: 'aws',
                            region: process.env.PINECONE_ENVIRONMENT.trim()
                        }
                    }
                });
                
                // Wait for index to be ready
                console.log('⏳ Waiting for index to be ready...');
                await new Promise(resolve => setTimeout(resolve, 60000));
            }

            this.index = this.pinecone.index(indexName);
            console.log(`✅ Connected to Pinecone index: ${indexName}`);

        } catch (error) {
            console.error('❌ Pinecone index initialization failed:', error.message);
            throw error;
        }
    }

    async ensureMongoIndexes() {
        if (!this.mongoAvailable()) {
            return;
        }
        if (this._mongoIndexesEnsured) {
            return;
        }
        try {
            await Promise.all([
                this.pagesColl.createIndex({ url: 1 }, { unique: true, background: true }),
                this.pagesColl.createIndex({ contentHash: 1 }, { background: true }),
                this.chunksColl.createIndex({ chunkId: 1 }, { unique: true, background: true }),
                this.chunksColl.createIndex({ url: 1 }, { background: true }),
                this.chunksColl.createIndex({ url: 1, index: 1 }, { background: true }),
            ]);
            this._mongoIndexesEnsured = true;
            console.log('[mongo] change ledger indexes ensured');
        } catch (error) {
            console.warn('[mongo] failed to ensure indexes:', error?.message || error);
        }
    }

    buildLinkDatabase(scrapedData) {
        console.log('🔗 Building comprehensive link database...');
        
        // Store all types of links for easy retrieval
        if (scrapedData.links) {
            // PDF links
            scrapedData.links.pdf?.forEach(link => {
                const key = `pdf_${link.text.toLowerCase().replace(/\s+/g, '_')}`;
                this.linkDatabase.set(key, {
                    type: 'pdf',
                    url: link.url,
                    text: link.text,
                    title: link.title,
                    sourceUrl: link.sourceUrl,
                    sourceTitle: link.sourceTitle,
                    context: link.context
                });
                
                // Also store by URL patterns
                const urlParts = link.url.split('/');
                const filename = urlParts[urlParts.length - 1].replace('.pdf', '');
                this.linkDatabase.set(`pdf_${filename.toLowerCase()}`, this.linkDatabase.get(key));
            });

            // Internal page links
            scrapedData.links.internal?.forEach(link => {
                const key = `page_${link.text.toLowerCase().replace(/\s+/g, '_')}`;
                this.linkDatabase.set(key, {
                    type: 'page',
                    url: link.url,
                    text: link.text,
                    title: link.title,
                    sourceUrl: link.sourceUrl,
                    sourceTitle: link.sourceTitle,
                    context: link.context
                });
            });
        }

        // Store page URLs for direct access
        scrapedData.pages?.forEach(page => {
            const key = `page_${page.title.toLowerCase().replace(/\s+/g, '_')}`;
            this.linkDatabase.set(key, {
                type: 'page',
                url: page.url,
                text: page.title,
                title: page.title,
                category: page.category,
                wordCount: page.wordCount
            });
        });

        // Store PDF document info
        scrapedData.documents?.pdfs?.forEach(pdf => {
            const key = `pdf_${pdf.title.toLowerCase().replace(/\s+/g, '_')}`;
            this.linkDatabase.set(key, {
                type: 'pdf_document',
                url: pdf.url,
                text: pdf.title,
                title: pdf.title,
                pages: pdf.pages,
                category: pdf.category,
                sourceUrl: pdf.parentPageUrl,
                sourceTitle: pdf.parentPageTitle,
                wordCount: pdf.wordCount
            });
        });

        console.log(`✅ Built link database with ${this.linkDatabase.size} entries`);
    }
    
    buildPageLinkStats(scrapedData = {}) {
        const stats = new Map();
        const linkBuckets = scrapedData?.links || {};

        const getOrCreateEntry = (sourceUrl) => {
            if (!sourceUrl) {
                return null;
            }
            if (!stats.has(sourceUrl)) {
                stats.set(sourceUrl, {
                    total: 0,
                    pdf: 0,
                    internal: 0,
                    external: 0,
                    image: 0
                });
            }
            return stats.get(sourceUrl);
        };

        const accumulate = (links = [], type) => {
            if (!Array.isArray(links)) {
                return;
            }
            links.forEach(link => {
                const entry = getOrCreateEntry(link?.sourceUrl);
                if (!entry) {
                    return;
                }
                entry.total += 1;
                if (typeof entry[type] === 'number') {
                    entry[type] += 1;
                } else {
                    entry[type] = 1;
                }
            });
        };

        accumulate(linkBuckets.pdf, 'pdf');
        accumulate(linkBuckets.internal, 'internal');
        accumulate(linkBuckets.external, 'external');
        accumulate(linkBuckets.image, 'image');

        return stats;
    }

    prepareIngestionItems(scrapedData = {}) {
        const items = [];
        const pageLinkStats = this.buildPageLinkStats(scrapedData);
        const pages = scrapedData.pages || [];
        for (const page of pages) {
            const xhrText = extractTextFromXhrResponses(page?.xhrResponses || []);
            const structuredParts = [
                `Title: ${page.title || ''}`,
                `URL: ${page.url}`,
                `Category: ${page.category || 'general'}`,
                page.headings?.map(h => `Heading ${h.level}: ${h.text}`).join('\n') || '',
                page.content || '',
                flattenTablesToText(page.tables) || '',
                page.lists?.map(list => list.map(item => `- ${item}`).join('\n')).join('\n\n') || '',
                `Description: ${page.metadata?.description || ''}`,
                `Keywords: ${page.metadata?.keywords || ''}`
            ];

            if (xhrText) {
                structuredParts.push(`XHR API Insights:\n${xhrText}`);
            }

            const structuredText = structuredParts.filter(Boolean).join('\n\n');

            if (!structuredText || structuredText.trim().length <= 100) {
                continue;
            }
            const hasXhr = Boolean(xhrText);
            const combinedWordCount = countWords(structuredText);

            const linkStats = pageLinkStats.get(page.url) 
                ? { ...pageLinkStats.get(page.url) } 
                : { total: 0, pdf: 0, internal: 0, external: 0, image: 0 };

            const metadataBase = {
                source: 'webpage',
                sourceType: 'page',
                url: page.url,
                title: page.title,
                timestamp: page.timestamp,
                category: page.category || 'general',
                depth: page.depth || 0,
                wordCount: combinedWordCount || page.wordCount || 0,
                hasLinks: (linkStats.total || 0) > 0,
                linkStats,
                hasTables: Array.isArray(page.tables) && page.tables.length > 0,
                hasLists: Array.isArray(page.lists) && page.lists.length > 0,
                hasXHR: hasXhr,
                xhrCount: Array.isArray(page?.xhrResponses) ? page.xhrResponses.length : 0,
            };

            items.push({
                url: page.url,
                type: page.type || 'page',
                title: page.title || '',
                category: page.category || 'general',
                structuredText,
                wordCount: combinedWordCount || page.wordCount || 0,
                buildChunkMetadata: (index, totalChunks) => ({
                    ...metadataBase,
                    linkStats: JSON.stringify(metadataBase.linkStats || {}),
                    chunkIndex: index,
                    totalChunks,
                }),
            });
        }

        const pdfs = scrapedData.documents?.pdfs || [];
        for (const pdf of pdfs) {
            const pdfContent = pdf.text || pdf.content || '';
            if (!pdfContent || pdfContent.trim().length <= 100) {
                continue;
            }

            const structuredPdfText = [
                `PDF Title: ${pdf.title}`,
                `URL: ${pdf.url}`,
                `Category: ${pdf.category || 'general'}`,
                `Pages: ${pdf.pages}`,
                `Source Page: ${pdf.parentPageTitle || 'Unknown'}`,
                `Content: ${pdfContent}`
            ].filter(Boolean).join('\n\n');

            const metadataBase = {
                source: 'pdf',
                sourceType: 'pdf_document',
                url: pdf.url,
                title: pdf.title,
                pages: pdf.pages,
                timestamp: pdf.timestamp,
                category: pdf.category || 'general',
                sourceUrl: pdf.parentPageUrl,
                sourceTitle: pdf.parentPageTitle,
                wordCount: pdf.wordCount || countWords(structuredPdfText),
            };

            items.push({
                url: pdf.url,
                type: 'pdf',
                title: pdf.title || '',
                category: pdf.category || 'general',
                structuredText: structuredPdfText,
                wordCount: pdf.wordCount || countWords(structuredPdfText),
                buildChunkMetadata: (index, totalChunks) => ({
                    ...metadataBase,
                    linkStats: JSON.stringify(metadataBase.linkStats || {}),
                    chunkIndex: index,
                    totalChunks,
                }),
            });
        }

        if (scrapedData.links) {
            const linkContent = [
                `PDF Documents Available:`,
                scrapedData.links.pdf?.map(link =>
                    `- ${link.text} - ${link.url} (Found on: ${link.sourceTitle})`
                ).join('\n') || 'No PDFs found',
                `\nInternal Pages:`,
                scrapedData.links.internal?.slice(0, 50).map(link =>
                    `- ${link.text} - ${link.url}`
                ).join('\n') || 'No internal links found'
            ].join('\n');

            if (linkContent.trim().length > 100) {
                const virtualUrl = 'virtual://links-directory';
                const metadataBase = {
                    source: 'links',
                    sourceType: 'link_directory',
                    type: 'directory',
                    timestamp: scrapedData.metadata?.timestamp,
                    totalPdfs: scrapedData.links.pdf?.length || 0,
                    totalInternalLinks: scrapedData.links.internal?.length || 0,
                    url: virtualUrl,
                    title: 'Links Directory',
                    category: 'virtual',
                };

                items.push({
                    url: virtualUrl,
                    type: 'page',
                    title: 'Links Directory',
                    category: 'virtual',
                    structuredText: linkContent,
                    wordCount: countWords(linkContent),
                    buildChunkMetadata: (index, totalChunks) => ({
                        ...metadataBase,
                        linkStats: JSON.stringify(metadataBase.linkStats || {}),
                        chunkIndex: index,
                        totalChunks,
                    }),
                });
            }
        }

        const categoryCounts = (scrapedData.pages || []).reduce((acc, page) => {
            const key = page.category || 'general';
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});
        const buildCategoryLines = (counts, bullet) => {
            const entries = Object.entries(counts);
            if (!entries.length) return `${bullet} general: 0 pages`;
            return entries.map(([cat, count]) => `${bullet} ${cat}: ${count} pages`).join('\n');
        };

        const statsContent = [
            `NIT Jamshedpur Website Statistics and Overview:`,
            `Total Pages Scraped: ${scrapedData.statistics?.totalPages || 0}`,
            `Total PDF Documents: ${scrapedData.statistics?.totalPDFs || 0}`,
            `Total Links Found: ${scrapedData.statistics?.totalLinks || 0}`,
            `Categories Breakdown:`,
            buildCategoryLines(categoryCounts, '-'),
            `\nAvailable PDF Documents:`,
            scrapedData.documents?.pdfs?.map(pdf =>
                `- ${pdf.title} (${pdf.pages} pages, ${pdf.wordCount} words) - ${pdf.category}`
            ).join('\n') || 'No PDFs processed'
        ].join('\n');

        if (statsContent.trim().length > 100) {
            const virtualUrl = 'virtual://statistics';
            const metadataBase = {
                source: 'statistics',
                sourceType: 'summary',
                type: 'overview',
                timestamp: scrapedData.metadata?.timestamp,
                url: virtualUrl,
                title: 'Website Statistics Overview',
                category: 'virtual',
            };

            items.push({
                url: virtualUrl,
                type: 'page',
                title: 'Website Statistics Overview',
                category: 'virtual',
                structuredText: statsContent,
                wordCount: countWords(statsContent),
                buildChunkMetadata: (index, totalChunks) => ({
                    ...metadataBase,
                    linkStats: JSON.stringify(metadataBase.linkStats || {}),
                    chunkIndex: index,
                    totalChunks,
                }),
            });
        }

        return items;
    }

    async legacyProcessAndStoreDocuments(scrapedData) {
        console.log('📚 Processing and storing enhanced documents in vector database...');

        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            // Build comprehensive link database
            this.buildLinkDatabase(scrapedData);

            const documents = [];
            let docId = 0;

            // Handle enhanced scraper data format
            let pagesToProcess = scrapedData.pages || [];
            let pdfsToProcess = scrapedData.documents?.pdfs || [];
            const pageLinkStats = this.buildPageLinkStats(scrapedData);

            console.log(`📊 Processing ${pagesToProcess.length} pages and ${pdfsToProcess.length} PDFs`);

            // Process main page content with enhanced metadata
            for (const page of pagesToProcess) {
                // Combine all text content with better structure
                const structuredText = [
                    `Title: ${page.title || ''}`,
                    `URL: ${page.url}`,
                    `Category: ${page.category || 'general'}`,
                    page.headings?.map(h => `Heading ${h.level}: ${h.text}`).join('\n') || '',
                    page.content || '',
                    flattenTablesToText(page.tables) || '',
                    page.lists?.map(list => list.map(item => `• ${item}`).join('\n')).join('\n\n') || '',
                    `Description: ${page.metadata?.description || ''}`,
                    `Keywords: ${page.metadata?.keywords || ''}`
                ].filter(Boolean).join('\n\n');

                if (structuredText.trim().length > 100) {
                    const chunks = await this.textSplitter.splitText(structuredText);
                    
                    const linkStats = pageLinkStats.get(page.url) 
                        ? { ...pageLinkStats.get(page.url) } 
                        : { total: 0, pdf: 0, internal: 0, external: 0, image: 0 };

                    for (let i = 0; i < chunks.length; i++) {
                        documents.push({
                            id: `page-${docId}-chunk-${i}`,
                            text: chunks[i],
                            metadata: {
                                source: 'webpage',
                                sourceType: 'page',
                                url: page.url,
                                title: page.title,
                                timestamp: page.timestamp,
                                category: page.category || 'general',
                                depth: page.depth || 0,
                                wordCount: page.wordCount || 0,
                                chunkIndex: i,
                                totalChunks: chunks.length,
                                hasLinks: (linkStats.total || 0) > 0,
                                linkStats,
                                hasTables: page.tables?.length > 0,
                                hasLists: page.lists?.length > 0
                            }
                        });
                    }
                }
                docId++;
            }

            // Process PDF documents with enhanced metadata
            for (const pdf of pdfsToProcess) {
                const pdfContent = pdf.text || pdf.content || '';
                if (pdfContent && pdfContent.trim().length > 100) {
                    const structuredPdfText = [
                        `PDF Title: ${pdf.title}`,
                        `URL: ${pdf.url}`,
                        `Category: ${pdf.category || 'general'}`,
                        `Pages: ${pdf.pages}`,
                        `Source Page: ${pdf.parentPageTitle || 'Unknown'}`,
                        `Content: ${pdfContent}`
                    ].filter(Boolean).join('\n\n');

                    const chunks = await this.textSplitter.splitText(structuredPdfText);
                    
                    for (let i = 0; i < chunks.length; i++) {
                        documents.push({
                            id: `pdf-${docId}-chunk-${i}`,
                            text: chunks[i],
                            metadata: {
                                source: 'pdf',
                                sourceType: 'pdf_document',
                                url: pdf.url,
                                title: pdf.title,
                                pages: pdf.pages,
                                timestamp: pdf.timestamp,
                                category: pdf.category || 'general',
                                sourceUrl: pdf.parentPageUrl,
                                sourceTitle: pdf.parentPageTitle,
                                wordCount: pdf.wordCount,
                                chunkIndex: i,
                                totalChunks: chunks.length
                            }
                        });
                    }
                }
                docId++;
            }

            // Process link information as searchable content
            if (scrapedData.links) {
                const linkContent = [
                    `PDF Documents Available:`,
                    scrapedData.links.pdf?.map(link => 
                        `• ${link.text} - ${link.url} (Found on: ${link.sourceTitle})`
                    ).join('\n') || 'No PDFs found',
                    `\nInternal Pages:`,
                    scrapedData.links.internal?.slice(0, 50).map(link => 
                        `• ${link.text} - ${link.url}`
                    ).join('\n') || 'No internal links found'
                ].join('\n');

                if (linkContent.length > 100) {
                    documents.push({
                        id: 'links-directory',
                        text: linkContent,
                        metadata: {
                            source: 'links',
                            sourceType: 'link_directory',
                            type: 'directory',
                            timestamp: scrapedData.metadata?.timestamp,
                            totalPdfs: scrapedData.links.pdf?.length || 0,
                            totalInternalLinks: scrapedData.links.internal?.length || 0
                        }
                    });
                }
            }

            // Enhanced statistics document
            const statsContent = [
                `NIT Jamshedpur Website Statistics and Overview:`,
                `Total Pages Scraped: ${scrapedData.statistics?.totalPages || 0}`,
                `Total PDF Documents: ${scrapedData.statistics?.totalPDFs || 0}`,
                `Total Links Found: ${scrapedData.statistics?.totalLinks || 0}`,
                `Categories Breakdown:`,
                buildCategoryLines(categoryCounts, '•'),
                `\nAvailable PDF Documents:`,
                scrapedData.documents?.pdfs?.map(pdf => 
                    `• ${pdf.title} (${pdf.pages} pages, ${pdf.wordCount} words) - ${pdf.category}`
                ).join('\n') || 'No PDFs processed'
            ].join('\n');

            if (statsContent.length > 100) {
                documents.push({
                    id: 'statistics-enhanced',
                    text: statsContent,
                    metadata: {
                        source: 'statistics',
                        sourceType: 'summary',
                        type: 'overview',
                        timestamp: scrapedData.metadata?.timestamp
                    }
                });
            }

            console.log(`📊 Prepared ${documents.length} enhanced document chunks for embedding`);

            // Generate embeddings and store in batches
            const batchSize = 32; // Reasonable batch size for Cohere
            const batches = [];
            
            for (let i = 0; i < documents.length; i += batchSize) {
                batches.push(documents.slice(i, i + batchSize));
            }

            for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                const batch = batches[batchIndex];
                console.log(`🔄 Processing batch ${batchIndex + 1}/${batches.length}...`);

                try {
                    // Generate embeddings for batch (documents)
                    const embeddings = await this.embeddings.embedDocuments(
                        batch.map(doc => doc.text)
                    );

                    // Prepare vectors for Pinecone
                    const vectors = batch.map((doc, index) => ({
                        id: doc.id,
                        values: embeddings[index],
                        metadata: {
                            text: doc.text.substring(0, 1000), // Pinecone metadata limit
                            ...doc.metadata
                        }
                    }));

                    // Upsert to Pinecone
                    await this.index.upsert(vectors);
                    
                    console.log(`✅ Batch ${batchIndex + 1} stored successfully`);

                    // Add delay to avoid rate limits
                    if (batchIndex < batches.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }

                } catch (error) {
                    console.error(`❌ Error processing batch ${batchIndex + 1}:`, error.message);
                }
            }

            console.log(`🎉 Successfully stored ${documents.length} enhanced documents in vector database`);
            return { success: true, totalDocuments: documents.length };

        } catch (error) {
            console.error('❌ Error processing enhanced documents:', error.message);
            throw error;
        }
    }

    async _ingestWithLedger(scrapedData, options = {}) {
        const { preview = false } = options || {};

        if (!this.isInitialized) {
            await this.initialize();
        }

        this.buildLinkDatabase(scrapedData);

        if (!this.mongoAvailable()) {
            if (preview) {
                return {
                    preview: {
                        fallback: true,
                        reason: 'MongoDB not connected',
                        counts: {
                            pages: { new: 0, modified: 0, unchanged: 0, deletedCandidate: 0 },
                            chunks: { toEmbed: 0, toDelete: 0 },
                        },
                    },
                };
            }

            if (Date.now() - this._lastLedgerWarning > 10000) {
                this._lastLedgerWarning = Date.now();
                console.warn('[mongo-ledger] MongoDB unavailable; using legacy ingestion path.');
            }
            return this.legacyProcessAndStoreDocuments(scrapedData);
        }

        await this.ensureMongoIndexes();

        const runStartTimestamp = Date.now();
        const runStartedAt = nowIso();
        const ingestionItems = this.prepareIngestionItems(scrapedData);
        console.log(`[mongo-ledger] Starting ${preview ? 'preview ' : ''}ledger ingestion run at ${runStartedAt} with ${ingestionItems.length} source items.`);
        const seenUrls = new Set();
        const pagePlans = [];
        const stats = {
            pages: { new: 0, modified: 0, unchanged: 0, deletedCandidate: 0 },
            chunks: { toEmbed: 0, toDelete: 0 },
        };

        try {
            for (const item of ingestionItems) {
                const normalizedText = (item.structuredText || '').trim();
                if (!normalizedText) {
                    continue;
                }

                seenUrls.add(item.url);

                const wordCount = item.wordCount || countWords(normalizedText);
                const contentHash = hashString(normalizedText);
                const existingPage = await this.pagesColl.findOne(
                    { url: item.url },
                    { projection: { url: 1, contentHash: 1, chunkCount: 1, version: 1, deleted: 1, lastEmbeddedAt: 1 } }
                );

                let status = 'NEW';
                if (existingPage && existingPage.deleted) {
                    status = 'NEW';
                } else if (existingPage) {
                    status = existingPage.contentHash === contentHash ? 'UNCHANGED' : 'MODIFIED';
                }

                const statusKey = status.toLowerCase();
                if (typeof stats.pages[statusKey] === 'number') {
                    stats.pages[statusKey] += 1;
                }

                if (status === 'UNCHANGED') {
                    pagePlans.push({
                        url: item.url,
                        status,
                        type: item.type,
                        title: item.title,
                        category: item.category,
                        wordCount,
                        contentHash,
                        chunkCount: existingPage?.chunkCount || 0,
                        existingPage,
                    });
                    continue;
                }

                const splits = await this.textSplitter.splitText(normalizedText);
                const chunkCount = splits.length;

                let existingChunksArr = [];
                if (existingPage) {
                    existingChunksArr = await this.chunksColl.find(
                        { url: item.url },
                        { projection: { chunkId: 1, textHash: 1 } }
                    ).toArray();
                }

                const existingChunkMap = new Map(existingChunksArr.map(doc => [doc.chunkId, doc]));
                const currentChunkIds = new Set();
                const chunkInfos = [];

                for (let index = 0; index < splits.length; index++) {
                    const chunkText = splits[index];
                    const textHash = hashString(chunkText);
                    const chunkId = makeChunkId(item.url, index, textHash);
                    currentChunkIds.add(chunkId);

                    const existingChunk = existingChunkMap.get(chunkId);
                    if (existingChunk && existingChunk.textHash === textHash) {
                        continue;
                    }

                    const metadata = item.buildChunkMetadata(index, chunkCount);
                    chunkInfos.push({
                        chunkId,
                        url: item.url,
                        index,
                        text: chunkText,
                        textHash,
                        metadata,
                    });
                }

                const toDeleteIds = existingChunksArr
                    .filter(doc => !currentChunkIds.has(doc.chunkId))
                    .map(doc => doc.chunkId);

                stats.chunks.toEmbed += chunkInfos.length;
                stats.chunks.toDelete += toDeleteIds.length;

                pagePlans.push({
                    url: item.url,
                    status,
                    type: item.type,
                    title: item.title,
                    category: item.category,
                    wordCount,
                    contentHash,
                    chunkCount,
                    chunkInfos,
                    toDeleteIds,
                    existingPage,
                });
            }

            console.log(`[mongo-ledger] Page plan summary: new=${stats.pages.new}, modified=${stats.pages.modified}, unchanged=${stats.pages.unchanged}, toEmbed=${stats.chunks.toEmbed}, toDelete=${stats.chunks.toDelete}.`);

            // we no longer auto-delete pages that were not in this scrape
            const seenUrlsArray = Array.from(seenUrls);
            const staleUrls = [];
            stats.pages.deletedCandidate = 0;


            if (preview) {
                console.log('[mongo-ledger] Preview ledger ingestion complete (no writes performed).');
                return {
                    preview: {
                        runStartedAt,
                        counts: stats,
                        seenUrls: seenUrls.size,
                        staleUrls,
                    },
                };
            }

            const chunksToEmbed = pagePlans.flatMap(plan => plan.chunkInfos || []);
            const batchSize = 32;
            const totalBatches = Math.ceil(chunksToEmbed.length / batchSize);
            const embeddedUrls = new Set();
            const nowForChunks = nowIso();

            if (chunksToEmbed.length === 0) {
                console.log('[mongo-ledger] No chunks require embedding this run.');
            } else {
                console.log(`[mongo-ledger] Embedding ${chunksToEmbed.length} chunks across ${totalBatches} batches (batchSize=${batchSize}).`);
            }

            for (let i = 0; i < chunksToEmbed.length; i += batchSize) {
                const batch = chunksToEmbed.slice(i, i + batchSize);
                if (batch.length === 0) continue;

                const batchIndex = Math.floor(i / batchSize);
                console.log(`[mongo-ledger] Upserting batch ${batchIndex + 1}/${totalBatches} (size=${batch.length}).`);

                const embeddings = await this.embeddings.embedDocuments(batch.map(chunk => chunk.text));
                const vectors = batch.map((chunk, index) => ({
                    id: chunk.chunkId,
                    values: embeddings[index],
                    metadata: {
                        text: chunk.text.substring(0, 1000),
                        ...chunk.metadata,
                    },
                }));

                let upsertSucceeded = false;
                try {
                    await this.index.upsert(vectors);
                    upsertSucceeded = true;
                } catch (error) {
                    console.error('[mongo-ledger] Pinecone upsert failed:', error?.message || error);
                }

                if (upsertSucceeded) {
                    console.log(`[mongo-ledger] Batch ${batchIndex + 1}/${totalBatches} stored successfully.`);
                    const bulkOps = batch.map(chunk => ({
                        updateOne: {
                            filter: { chunkId: chunk.chunkId },
                            update: {
                                $set: {
                                    url: chunk.url,
                                    index: chunk.index,
                                    textHash: chunk.textHash,
                                    pineconeId: chunk.chunkId,
                                    storedAt: nowForChunks,
                                    metadataSnapshot: {
                                        source: chunk.metadata.source,
                                        sourceType: chunk.metadata.sourceType,
                                        title: chunk.metadata.title,
                                        category: chunk.metadata.category,
                                        chunkIndex: chunk.metadata.chunkIndex,
                                        totalChunks: chunk.metadata.totalChunks,
                                    },
                                },
                            },
                            upsert: true,
                        },
                    }));

                    if (bulkOps.length) {
                        await this.chunksColl.bulkWrite(bulkOps, { ordered: false });
                    }
                    batch.forEach(chunk => embeddedUrls.add(chunk.url));
                }
            }

            let deleteIds = pagePlans.flatMap(plan => plan.toDeleteIds || []);
            deleteIds = [...new Set(deleteIds)];
            if (deleteIds.length === 0) {
                console.log('[mongo-ledger] No unique IDs to delete.');
            } else {
                console.log(`[mongo-ledger] Deleting ${deleteIds.length} chunk vectors marked stale during ingestion.`);
                try {
                    const stats = await this.index.describeIndexStats();
                    const totalVectors = stats?.totalVectorCount || 0;
                    if (totalVectors === 0) {
                        console.log('[mongo-ledger] Skipping deletes: Pinecone index is empty or fresh.');
                    } else {
                        const BATCH_SIZE = 500;
                        for (let i = 0; i < deleteIds.length; i += BATCH_SIZE) {
                            const batch = deleteIds.slice(i, i + BATCH_SIZE);
                            await this.index.deleteMany({ ids: batch });
                        }
                    }
                } catch (error) {
                    console.warn('[mongo-ledger] Pinecone delete failed:', error?.message || error);
                }
                try {
                    await this.chunksColl.deleteMany({ chunkId: { $in: deleteIds } });
                } catch (error) {
                    console.warn('[mongo-ledger] Mongo chunk delete failed:', error?.message || error);
                }
            }

            const pageUpdateTime = nowIso();
            for (const plan of pagePlans) {
                const versionBase = plan.existingPage?.version || 0;
                const removedChunks = (plan.toDeleteIds?.length || 0) > 0;
                const changedWithoutEmbed = plan.status === 'MODIFIED' && removedChunks && !embeddedUrls.has(plan.url);
                const shouldBumpVersion = embeddedUrls.has(plan.url) || plan.status === 'NEW' || changedWithoutEmbed;
                const updateDoc = {
                    url: plan.url,
                    type: plan.type,
                    title: plan.title,
                    category: plan.category,
                    wordCount: plan.wordCount,
                    contentHash: plan.contentHash,
                    chunkCount: plan.chunkCount ?? plan.existingPage?.chunkCount ?? 0,
                    lastSeenAt: runStartedAt,
                    deleted: false,
                    version: shouldBumpVersion ? versionBase + 1 : versionBase,
                };

                if (embeddedUrls.has(plan.url) || changedWithoutEmbed) {
                    updateDoc.lastEmbeddedAt = pageUpdateTime;
                } else if (plan.existingPage?.lastEmbeddedAt) {
                    updateDoc.lastEmbeddedAt = plan.existingPage.lastEmbeddedAt;
                }

                await this.pagesColl.updateOne(
                    { url: plan.url },
                    { $set: updateDoc },
                    { upsert: true }
                );
            }

            // if (stats.pages.deletedCandidate > 0) {
            //     let staleChunkIds = [];
            //     try {
            //         const staleChunkDocs = await this.chunksColl.find(
            //             { url: { $in: staleUrls } },
            //             { projection: { chunkId: 1 } }
            //         ).toArray();
            //         staleChunkIds = staleChunkDocs.map(doc => doc.chunkId);
            //     } catch (error) {
            //         console.warn('[mongo-ledger] failed to list stale chunks:', error?.message || error);
            //     }

            //     if (staleChunkIds.length) {
            //         staleChunkIds = [...new Set(staleChunkIds)];
            //         if (staleChunkIds.length === 0) {
            //             console.log('[mongo-ledger] No unique IDs to delete.');
            //         } else {
            //             console.log(`[mongo-ledger] Deleting ${staleChunkIds.length} chunk vectors from stale pages.`);
            //             try {
            //                 const stats = await this.index.describeIndexStats();
            //                 const totalVectors = stats?.totalVectorCount || 0;
            //                 if (totalVectors === 0) {
            //                     console.log('[mongo-ledger] Skipping deletes: Pinecone index is empty or fresh.');
            //                 } else {
            //                     const BATCH_SIZE = 500;
            //                     for (let i = 0; i < staleChunkIds.length; i += BATCH_SIZE) {
            //                         const batch = staleChunkIds.slice(i, i + BATCH_SIZE);
            //                         await this.index.deleteMany({ ids: batch });
            //                     }
            //                 }
            //             } catch (error) {
            //                 console.warn('[mongo-ledger] Pinecone delete (stale) failed:', error?.message || error);
            //             }
            //             try {
            //                 await this.chunksColl.deleteMany({ chunkId: { $in: staleChunkIds } });
            //             } catch (error) {
            //                 console.warn('[mongo-ledger] Mongo delete (stale chunks) failed:', error?.message || error);
            //             }
            //         }
            //     }

            //     try {
            //         await this.pagesColl.updateMany(
            //             { url: { $in: staleUrls } },
            //             { $set: { deleted: true, lastSeenAt: runStartedAt } }
            //         );
            //     } catch (error) {
            //         console.warn('[mongo-ledger] failed to mark stale pages as deleted:', error?.message || error);
            //     }
            // }

            const durationMs = Date.now() - runStartTimestamp;
            console.log(`[mongo-ledger] Ledger ingestion completed in ${durationMs} ms. Pages seen=${seenUrls.size}, embedded=${embeddedUrls.size}, deletes=${stats.chunks.toDelete}.`);

            return {
                success: true,
                ledger: true,
                runStartedAt,
                stats,
            };
        } catch (error) {
            console.error('[mongo-ledger] ingestion error:', error?.message || error);
            if (!preview) {
                console.warn('[mongo-ledger] Falling back to legacy ingestion path.');
                return this.legacyProcessAndStoreDocuments(scrapedData);
            }
            throw error;
        }
    }

    async processAndStoreDocuments(scrapedData, options = {}) {
        if (options?.preview) {
            return this.previewIngestion(scrapedData);
        }
        return this._ingestWithLedger(scrapedData, { preview: false });
    }

    async previewIngestion(scrapedData) {
        const result = await this._ingestWithLedger(scrapedData, { preview: true });
        return result.preview;
    }

    findRelevantLinks(question, documents) {
        const questionLower = question.toLowerCase();
        const relevantLinks = [];

        // Search for PDF links
        if (questionLower.includes('pdf') || questionLower.includes('document')) {
            for (const [key, link] of this.linkDatabase.entries()) {
                if (key.startsWith('pdf_') && (
                    link.text.toLowerCase().includes(questionLower) ||
                    questionLower.includes(link.text.toLowerCase()) ||
                    documents.some(doc => doc.text.toLowerCase().includes(link.text.toLowerCase()))
                )) {
                    relevantLinks.push(link);
                }
            }
        }

        // Search for relevant pages
        for (const [key, link] of this.linkDatabase.entries()) {
            if ((link.text.toLowerCase().includes(questionLower) || 
                 questionLower.includes(link.text.toLowerCase()) ||
                 (link.category && questionLower.includes(link.category))) &&
                relevantLinks.length < 5) {
                relevantLinks.push(link);
            }
        }

        return relevantLinks;
    }

    async queryDocuments(question, topK = 8, precomputedEmbedding = null) { // Increased topK for better context
        console.log(`🔍 Searching for: "${question}"`);

        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            // Generate embedding for the question using Cohere with cache (reuse if provided)
            const questionEmbedding = precomputedEmbedding || await this.embeddingCache.getQueryEmbedding(
                question,
                async (q) => await this.embeddings.embedQuery(q)
            );
            try {
                const ecStats = this.embeddingCache.getStats();
                console.log(`[EmbeddingCache] stats hits=${ecStats.hits} misses=${ecStats.misses} backend=${ecStats.backend}`);
            } catch (_) {}

            // Search Pinecone
            const searchResults = await this.index.query({
                vector: questionEmbedding,
                topK: topK,
                includeMetadata: true,
                includeValues: false
            });

            const relevantDocuments = searchResults.matches?.map(match => ({
                text: match.metadata.text,
                score: match.score,
                metadata: match.metadata
            })) || [];

            console.log(`📋 Found ${relevantDocuments.length} relevant documents`);
            return relevantDocuments;

        } catch (error) {
            console.error('❌ Error querying documents:', error.message);
            throw error;
        }
    }

    async generateResponse(question, relevantDocuments) {
        console.log('🤖 Generating response with Gemini...');

        try {
            // Find relevant links
            const relevantLinks = this.findRelevantLinks(question, relevantDocuments);

            // Create enhanced context from relevant documents
            const context = relevantDocuments
                .map((doc, index) => {
                    const sourceInfo = doc.metadata.sourceType === 'pdf_document' 
                        ? `[PDF Document ${index + 1}: ${doc.metadata.title} (${doc.metadata.pages} pages)]`
                        : `[Page ${index + 1}: ${doc.metadata.title}]`;
                    return `${sourceInfo} ${doc.text}`;
                })
                .join('\n\n');

            // Add links information to context
            const linksContext = relevantLinks.length > 0 
                ? `\n\nRelevant Links Available:\n${relevantLinks.map(link => 
                    `• ${link.text}: ${link.url} ${link.type === 'pdf' ? '(PDF Document)' : '(Web Page)'}`
                  ).join('\n')}`
                : '';

            // Create enhanced prompt for Gemini
            const prompt = `You are an AI assistant specializing in NIT Jamshedpur information. Use the provided context to answer questions accurately and helpfully.

Context:
${context || 'No relevant context found.'}${linksContext}

Question: ${question}

Instructions:
- Answer based primarily on the provided context
- If the context doesn't contain enough information, state that clearly
- Provide specific data points when available (percentages, package amounts, company names)
- Be comprehensive but well-structured
- When mentioning statistics, provide the source or timeframe when available
- If relevant links are available, mention them in your response
- For PDF documents, specify the document name and that it's a PDF
- Include direct URLs when they would be helpful to the user
- Format your response clearly with proper structure
- If asked about documents or PDFs, provide the actual links when available

Answer:`;

            // Generate response using Gemini
            const result = await this.chatModel.generateContent(prompt);
            const response = result.response;
            const text = response.text();

            console.log('✅ Response generated successfully');

            // Prepare sources with links
            const enhancedSources = relevantDocuments.map(doc => ({
                text: doc.text.substring(0, 200) + '...',
                source: doc.metadata.source,
                sourceType: doc.metadata.sourceType,
                url: doc.metadata.url,
                title: doc.metadata.title,
                score: doc.score,
                pages: doc.metadata.pages,
                category: doc.metadata.category
            }));

            // Add relevant links as additional sources
            relevantLinks.forEach(link => {
                enhancedSources.push({
                    text: link.context || link.text,
                    source: link.type,
                    sourceType: 'link',
                    url: link.url,
                    title: link.text,
                    score: 0.8, // High relevance for matched links
                    category: 'link'
                });
            });

            return {
                answer: text,
                sources: enhancedSources,
                relevantLinks: relevantLinks,
                confidence: relevantDocuments.length > 0 ? relevantDocuments[0].score : 0
            };

        } catch (error) {
            console.error('❌ Error generating enhanced response:', error.message);
            throw error;
        }
    }

    async chat(question, precomputedEmbedding = null) {
        try {
            // Search for relevant documents
            // Compute question embedding once and reuse across cache + search
            const questionEmbedding = precomputedEmbedding || await this.embeddingCache.getQueryEmbedding(
                question,
                async (q) => await this.embeddings.embedQuery(q)
            );
            try {
                const ecStats = this.embeddingCache.getStats();
                console.log(`[EmbeddingCache] stats hits=${ecStats.hits} misses=${ecStats.misses} backend=${ecStats.backend}`);
            } catch (_) {}

            // Search for relevant documents (reuse embedding)
            const relevantDocs = await this.queryDocuments(question, 8, questionEmbedding);

            if (relevantDocs.length === 0) {
                return {
                    answer: "I don't have specific information about that topic in the NIT Jamshedpur data. Could you please rephrase your question or ask about placements, academics, faculty, departments, or other college-related topics?",
                    sources: [],
                    relevantLinks: [],
                    confidence: 0
                };
            }

            // Generate response
            const response = await this.generateResponse(question, relevantDocs);
            return response;

        } catch (error) {
            console.error('❌ Chat error:', error.message);
            throw error;
        }
    }

   // RagSystem.js — replace your getIndexStats() with this minimal fix
    async getIndexStats() {
    try {
        const stats = await this.index.describeIndexStats({});

        // NEW: derive total from supported fields
        const totalFromNamespaces = Object
        .values(stats?.namespaces ?? {})
        .reduce((sum, ns) => sum + (ns?.vectorCount ?? 0), 0);

        const totalVectors = (
        typeof stats?.totalRecordCount === 'number' ? stats.totalRecordCount : totalFromNamespaces
        );

        return {
        totalVectors,
        dimension: stats?.dimension ?? 1024,
        indexFullness: stats?.indexFullness ?? 0,
        linkDatabaseSize: this.linkDatabase?.size ?? 0,
        };
    } catch (error) {
        console.error('❌ Error getting index stats:', error.message || error);
        return { totalVectors: 0, error: String(error?.message || error) };
    }
    }

    async clearIndex() {
        console.log('🗑️ Clearing Pinecone index and link database...');
        try {
            await this.index.deleteAll();
            this.linkDatabase.clear();
            console.log('✅ Index and link database cleared successfully');
        } catch (error) {
            console.error('❌ Error clearing index:', error.message);
            throw error;
        }
    }
}

export { NITJSRRAGSystem };









