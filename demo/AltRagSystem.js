import dotenv from 'dotenv';
import { Pinecone } from '@pinecone-database/pinecone';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { GoogleGenerativeAI } from '@google/generative-ai';
// Load transformers pipeline lazily to provide clearer error if not installed

dotenv.config();

class DemoRAGSystem {
  constructor() {
    this.pinecone = null;
    this.index = null;
    this.chatModel = null; // Gemini for generation
    this.textSplitter = null;
    this.isInitialized = false;
    this.linkDatabase = new Map();
    this.embedder = null; // local embeddings
    this.indexName = null;
  }

  async initialize() {
    if (this.isInitialized) return;

    console.log('🚀 Initializing Local-Embeddings + Pinecone RAG System (demo)...');
    try {
      // Gemini for generation (keep same as original) with model fallback
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const candidates = [
        process.env.DEMO_GEN_MODEL?.trim(),
        'gemini-1.5-flash',
        'gemini-1.5-flash-latest',
        'gemini-1.5-flash-8b',
        'gemini-1.0-pro',
        'gemini-pro'
      ].filter(Boolean);
      let set = false;
      for (const m of candidates) {
        try {
          const mdl = genAI.getGenerativeModel({ model: m });
          // Lightweight readiness probe
          await mdl.generateContent('ok');
          this.chatModel = mdl;
          console.log(`✅ Gemini generation model set: ${m}`);
          set = true;
          break;
        } catch (e) {
          const msg = String(e?.message || e);
          if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
            console.log(`�s��,? Gemini model not available: ${m}`);
            continue;
          }
          // For quota/network errors, still adopt the model and let requests handle it later
          this.chatModel = genAI.getGenerativeModel({ model: m });
          console.log(`⚠️ Using Gemini model ${m} without probe (reason: ${msg})`);
          set = true;
          break;
        }
      }
      if (!set) throw new Error('No supported Gemini model available. Set DEMO_GEN_MODEL to a supported model.');

      // Pinecone
      this.pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY.trim() });
      await this.initializePineconeIndex();

      // Text splitter
      this.textSplitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1200,
        chunkOverlap: 300,
        separators: ['\n\n', '\n', '. ', '! ', '? ', ' ', ''],
      });

      // Local sentence embedding model (free)
      // Configure via env:
      // DEMO_EMBED_MODEL (default: 'Xenova/all-MiniLM-L6-v2')
      // DEMO_EMBED_DIM (default: 384) MUST match Pinecone index dimension
      try {
        const { pipeline } = await import('@xenova/transformers');
        const model = process.env.DEMO_EMBED_MODEL?.trim() || 'Xenova/all-MiniLM-L6-v2';
        this.embedder = await pipeline('feature-extraction', model);
      } catch (e) {
        throw new Error("@xenova/transformers is not installed. Run 'npm install @xenova/transformers' and try again. " + e.message);
      }

      this.isInitialized = true;
      console.log('✅ Demo RAG System (local embeddings) initialized!');
    } catch (e) {
      console.error('❌ Demo RAG initialization failed:', e.message);
      throw e;
    }
  }

  async initializePineconeIndex() {
    const base = process.env.PINECONE_INDEX_NAME?.trim();
    const alt = process.env.PINECONE_INDEX_NAME_ALT?.trim();
    const indexName = alt || `${base}-local`;

    try {
      const list = await this.pinecone.listIndexes();
      const exists = list.indexes?.some(i => i.name === indexName);
      if (!exists) {
        console.log(`🆕 Creating Pinecone index: ${indexName}`);
        const dim = parseInt(process.env.DEMO_EMBED_DIM || '384', 10);
        await this.pinecone.createIndex({
          name: indexName,
          dimension: dim,
          metric: 'cosine',
          spec: { serverless: { cloud: 'aws', region: process.env.PINECONE_ENVIRONMENT.trim() } }
        });
        console.log('⏳ Waiting 60s for index readiness...');
        await new Promise(r => setTimeout(r, 60000));
      }
      this.index = this.pinecone.index(indexName);
      this.indexName = indexName;
      console.log(`✅ Connected to Pinecone index: ${indexName}`);
      // Note: if connecting to an existing index, ensure DEMO_EMBED_DIM matches its dimension.
    } catch (e) {
      console.error('❌ Pinecone init failed:', e.message);
      throw e;
    }
  }

  buildLinkDatabase(scrapedData) {
    console.log('🔗 Building link database...');
    if (scrapedData.links) {
      scrapedData.links.pdf?.forEach(link => {
        const key = `pdf_${(link.text || link.url).toLowerCase().replace(/\s+/g, '_')}`;
        this.linkDatabase.set(key, { type: 'pdf', ...link });
        const filename = link.url.split('/').pop()?.replace('.pdf', '') || '';
        this.linkDatabase.set(`pdf_${filename.toLowerCase()}`, this.linkDatabase.get(key));
      });
      scrapedData.links.internal?.forEach(link => {
        const key = `page_${(link.text || link.url).toLowerCase().replace(/\s+/g, '_')}`;
        this.linkDatabase.set(key, { type: 'page', ...link });
      });
    }
    scrapedData.pages?.forEach(page => {
      if (!page?.title) return;
      const key = `page_${page.title.toLowerCase().replace(/\s+/g, '_')}`;
      this.linkDatabase.set(key, { type: 'page', url: page.url, text: page.title, title: page.title, category: page.category, wordCount: page.wordCount });
    });
    scrapedData.documents?.pdfs?.forEach(pdf => {
      const key = `pdf_${pdf.title.toLowerCase().replace(/\s+/g, '_')}`;
      this.linkDatabase.set(key, { type: 'pdf_document', url: pdf.url, text: pdf.title, title: pdf.title, pages: pdf.pages, category: pdf.category, sourceUrl: pdf.sourceUrl, wordCount: pdf.wordCount });
    });
    console.log(`✅ Link DB size: ${this.linkDatabase.size}`);
  }

  async processAndStoreDocuments(scrapedData) {
    console.log('📚 Processing and storing documents with local embeddings...');
    if (!this.isInitialized) await this.initialize();
    try {
      this.buildLinkDatabase(scrapedData);
      const documents = [];
      let docId = 0;

      const pages = scrapedData.pages || [];
      const pdfs = scrapedData.documents?.pdfs || [];
      console.log(`📊 Processing ${pages.length} pages and ${pdfs.length} PDFs`);

      for (const page of pages) {
        const structuredText = [
          `Title: ${page.title || ''}`,
          `URL: ${page.url}`,
          `Category: ${page.category || 'general'}`,
          page.headings?.map(h => `Heading ${h.level}: ${h.text}`).join('\n') || '',
          page.content || '',
          page.tables?.map(t => t.map(r => r.join(' | ')).join('\n')).join('\n\n') || '',
          page.lists?.map(list => list.map(item => `• ${item}`).join('\n')).join('\n\n') || '',
          `Description: ${page.metadata?.description || ''}`,
          `Keywords: ${page.metadata?.keywords || ''}`
        ].filter(Boolean).join('\n\n');
        if (structuredText.trim().length < 100) { docId++; continue; }
        const chunks = await this.textSplitter.splitText(structuredText);
        for (let i = 0; i < chunks.length; i++) {
          documents.push({
            id: `page-${docId}-chunk-${i}`,
            text: chunks[i],
            metadata: {
              source: 'webpage', sourceType: 'page', url: page.url, title: page.title,
              timestamp: page.timestamp, category: page.category || 'general', depth: page.depth || 0,
              wordCount: page.wordCount || 0, chunkIndex: i, totalChunks: chunks.length,
              hasLinks: page.links?.length > 0, hasTables: page.tables?.length > 0, hasLists: page.lists?.length > 0
            }
          });
        }
        docId++;
      }

      for (const pdf of pdfs) {
        const content = pdf.text || pdf.content || '';
        if (content.trim().length < 100) { docId++; continue; }
        const structured = [
          `PDF Title: ${pdf.title}`, `URL: ${pdf.url}`, `Category: ${pdf.category || 'general'}`,
          `Pages: ${pdf.pages}`, `Source Page: ${pdf.sourceTitle || 'Unknown'}`, `Content: ${content}`
        ].join('\n\n');
        const chunks = await this.textSplitter.splitText(structured);
        for (let i = 0; i < chunks.length; i++) {
          documents.push({
            id: `pdf-${docId}-chunk-${i}`,
            text: chunks[i],
            metadata: {
              source: 'pdf', sourceType: 'pdf_document', url: pdf.url, title: pdf.title, pages: pdf.pages,
              timestamp: pdf.timestamp, category: pdf.category || 'general', sourceUrl: pdf.sourceUrl,
              sourceTitle: pdf.sourceTitle, wordCount: pdf.wordCount, chunkIndex: i, totalChunks: chunks.length
            }
          });
        }
        docId++;
      }

      console.log(`📊 Prepared ${documents.length} chunks`);
      // Compute embeddings one by one to keep memory stable
      let processed = 0;
      const vectors = [];
      for (const doc of documents) {
        const embedding = await this.embedder(doc.text, { pooling: 'mean', normalize: true });
        // embedding is a Float32Array of length 384
        vectors.push({ id: doc.id, values: Array.from(embedding.data || embedding), metadata: { text: doc.text.substring(0, 1000), ...doc.metadata } });
        processed++;
        if (vectors.length >= 32) { // upsert in chunks
          await this.index.upsert(vectors.splice(0, vectors.length));
          console.log(`🔄 Upserted ${processed}/${documents.length}`);
        }
      }
      if (vectors.length) {
        await this.index.upsert(vectors);
      }

      console.log('✅ Stored documents in Pinecone (local embeddings)');
      return { success: true, totalDocuments: documents.length };
    } catch (e) {
      console.error('❌ Error processing documents:', e.message);
      throw e;
    }
  }

  async queryDocuments(question, topK = 8) {
    console.log(`🔍 Searching for: "${question}"`);
    if (!this.isInitialized) await this.initialize();
    try {
      const emb = await this.embedder(question, { pooling: 'mean', normalize: true });
      const vec = Array.from(emb.data || emb);
      const results = await this.index.query({ vector: vec, topK, includeMetadata: true, includeValues: false });
      const matches = results.matches?.map(m => ({ text: m.metadata.text, score: m.score, metadata: m.metadata })) || [];
      console.log(`🔎 Found ${matches.length} relevant documents`);
      return matches;
    } catch (e) {
      console.error('❌ Error querying documents:', e.message);
      throw e;
    }
  }

  findRelevantLinks(question, documents) {
    const q = (question || '').toLowerCase();
    const out = [];
    for (const [key, link] of this.linkDatabase.entries()) {
      const t = (link.text || '').toLowerCase();
      if (t.includes(q) || q.includes(t)) { out.push(link); if (out.length >= 5) break; }
    }
    return out;
  }

  async generateResponse(question, relevantDocuments) {
    console.log('🧠 Generating response with Gemini...');
    const links = this.findRelevantLinks(question, relevantDocuments);
    const context = relevantDocuments.map((doc, i) => {
      const src = doc.metadata.sourceType === 'pdf_document' ? `[PDF ${i + 1}: ${doc.metadata.title}]` : `[Page ${i + 1}: ${doc.metadata.title}]`;
      return `${src} ${doc.text}`;
    }).join('\n\n');

    const linksContext = links.length ? `\n\nRelevant Links:\n${links.map(l => `• ${l.text}: ${l.url} ${l.type === 'pdf' ? '(PDF)' : ''}`).join('\n')}` : '';
    const prompt = `You are an AI assistant specializing in NIT Jamshedpur information. Use the provided context to answer questions accurately and helpfully.\n\nContext:\n${context || 'No relevant context found.'}${linksContext}\n\nQuestion: ${question}\n\nInstructions:\n- Answer based on the provided context\n- If context is insufficient, say so\n- Provide specific data points and sources when available\n- Mention relevant links when helpful\n- Format clearly\n\nAnswer:`;
    const result = await this.chatModel.generateContent(prompt);
    const text = result.response.text();
    const sources = relevantDocuments.map(doc => ({
      text: doc.text.substring(0, 200) + '...',
      source: doc.metadata.source,
      sourceType: doc.metadata.sourceType,
      url: doc.metadata.url,
      title: doc.metadata.title,
      score: doc.score,
      pages: doc.metadata.pages,
      category: doc.metadata.category
    }));
    links.forEach(l => sources.push({ text: l.context || l.text, source: l.type, sourceType: 'link', url: l.url, title: l.text, score: 0.8, category: 'link' }));
    return { answer: text, sources, relevantLinks: links, confidence: relevantDocuments[0]?.score || 0 };
  }

  async chat(question) {
    try {
      const docs = await this.queryDocuments(question, 8);
      if (!docs.length) {
        return { answer: "I don't have specific information in the demo data.", sources: [], relevantLinks: [], confidence: 0 };
      }
      return await this.generateResponse(question, docs);
    } catch (e) {
      console.error('❌ Chat error:', e.message);
      throw e;
    }
  }

  async getIndexStats() {
    try {
      const stats = await this.index.describeIndexStats();
      // Pinecone v2 returns namespaces with vectorCount per namespace
      let total = 0;
      if (stats?.namespaces) {
        for (const ns of Object.values(stats.namespaces)) {
          const n = ns?.vectorCount ?? ns?.recordCount ?? 0;
          total += n;
        }
      }
      return { totalVectors: total, dimension: stats.dimension || parseInt(process.env.DEMO_EMBED_DIM || '384', 10), indexFullness: stats.indexFullness || 0, linkDatabaseSize: this.linkDatabase.size };
    } catch (e) {
      return { error: e.message };
    }
  }

  async clearIndex() {
    console.log('🧹 Clearing Pinecone index and link DB...');
    await this.index.deleteAll();
    this.linkDatabase.clear();
  }
}

export { DemoRAGSystem };
