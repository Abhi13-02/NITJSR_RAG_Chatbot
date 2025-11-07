# NIT Jamshedpur RAG Chatbot

Retrieval-Augmented Generation (RAG) stack for answering questions about NIT Jamshedpur.  
The system scrapes the official institute website, chunks and embeds the content with Cohere, stores the vectors in Pinecone, and generates answers with Google Gemini.  
Express serves a simple web UI and a JSON API, while optional Redis and MongoDB integrations speed up repeated queries and keep track of data changes.

---

## What this project provides
- Automated scraper that walks key sections of `https://nitjsr.ac.in`, extracts structured text, and parses linked PDFs.
- Ingestion pipeline that deduplicates pages, builds stable chunk IDs, and pushes embeddings to Pinecone. A MongoDB "change ledger" records what changed across scrapes.
- Chat endpoint that performs semantic search with cached Cohere embeddings, calls Gemini for grounded answers, and returns supporting sources plus relevant links.
- Frontend (served from `public/`) that hits the REST API, displays status, and renders chat conversations.
- Optional Redis layer for query/response caches to keep repeated questions fast.

---

## Prerequisites
- **Node.js 18+** (the stack uses ES Modules and Puppeteer's bundled Chromium build).
- **npm** (installs dependencies and runs scripts).
- Accounts and API keys for:
  - Google Gemini (`GEMINI_API_KEY`)
  - Cohere embeddings (`COHERE_API_KEY`)
  - Pinecone vector database (`PINECONE_API_KEY`, index name, environment)
- **MongoDB** connection string (Atlas or self-hosted) if you want incremental ingestion and change tracking. Without it, the pipeline falls back to a legacy upsert path.
- **Redis** (local or remote) if you want persistent caches. A local instance is enough for development; see `docker-compose.yml`.
- Adequate disk space: `scraped_data/` holds timestamped JSON snapshots (~0.5 MB each with default scrape limits).

---

## Initial setup
1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Create `.env`** (never commit real keys). At minimum:
   ```env
   # AI providers
   GEMINI_API_KEY=your_gemini_key
   COHERE_API_KEY=your_cohere_key
   COHERE_EMBED_MODEL=embed-english-v3.0   # optional override

   # Pinecone
   PINECONE_API_KEY=your_pinecone_key
   PINECONE_INDEX_NAME=nitjsr-rag
   PINECONE_ENVIRONMENT=us-east-1

   # Server
   PORT=3000
   AUTO_INIT=true
   INIT_SKIP_EMBED_IF_INDEX_NOT_EMPTY=true

   # Optional services
   REDIS_URL=redis://localhost:6379/0
   MONGODB_URI=mongodb://localhost:27017
   MONGODB_DB=nitjsr_rag
   MONGO_PAGES_COLL=pages
   MONGO_CHUNKS_COLL=chunks
   ```
   See `.env` in this repo for additional tunables (timeouts, demo settings, cache knobs).
3. **Start supporting services (optional)**
   - Redis: `docker compose up -d redis`
   - MongoDB: point `MONGODB_URI` to Atlas or run a local instance.
4. **(One-time) fetch a sample PDF for pdf-parse (if Puppeteer struggles without it)**
   ```bash
   mkdir -p test/data
   curl -L "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf" \
     -o "test/data/05-versions-space.pdf"
   ```

---

## Typical workflow
1. **Scrape the website**
   ```bash
   npm run scrape -- --maxPages 100 --maxDepth 3 --delay 1500
   ```
   This creates `scraped_data/nitjsr_enhanced_comprehensive_<timestamp>.json`. Logs show page counts, PDFs found, and category splits.

2. **Embed into Pinecone**
   ```bash
   npm run embed -- --latest
   # or, to target a specific file:
   npm run embed -- --file scraped_data/<file>.json
   # add --force to wipe the Pinecone index first
   ```
   When MongoDB is configured the ingestion path writes a ledger of pages and chunks and removes stale vectors automatically.

3. **Serve the chatbot**
   - Development (nodemon + auto-init): `npm run dev`
   - Production style (single start + auto-init): `npm start`
   - Serve-only, no auto init (useful if vectors are already in Pinecone): `npm run serve`

   The server listens on `http://localhost:PORT` (3000 by default). The web UI and REST API share the same origin. If `AUTO_INIT=true`, startup runs `initializeSystem()` which pulls the latest scrape and embeds it unless Pinecone already has vectors and `INIT_SKIP_EMBED_IF_INDEX_NOT_EMPTY` is true.

4. **Chat / monitor**
   - Visit `http://localhost:PORT/` for the UI.
   - Hit REST endpoints (see below) for health, stats, and manual control.

---

## npm scripts and utilities
- `npm run scrape` -> launches `scripts/scrape.js`; accepts `--maxPages`, `--maxDepth`, `--delay`.
- `npm run embed` -> runs `scripts/embed.js`; accepts `--latest`, `--file`, `--force`.
- `npm run serve` -> starts the server with `AUTO_INIT=false` via `scripts/serve.js`.
- `npm run dev` -> nodemon watch mode for `server.js`.
- `npm run test:redis-emb-cache` / `npm run inspect:redis-emb-key` -> utilities for the embedding cache.
- `node testScraper.js` -> small harness that scrapes a handful of pages and prints a verbose summary.

---

## API surface (served from `server.js`)
- `GET /health` -> readiness info, cache stats, Pinecone totals, Mongo status.
- `POST /initialize` -> validates env vars, loads the latest scrape (or creates a new one), embeds, and marks the system initialized.
- `POST /embed-latest` -> reprocesses the newest file in `scraped_data/` and pushes vectors (requires Mongo for the ledger mode).
- `POST /scrape` -> triggers a fresh scrape; `{ "force": true }` clears Pinecone first.
- `POST /chat` -> `{ "question": "..." }` returns an answer, sources, and relevant links; uses the response cache when available.
- `GET /stats` -> aggregates Pinecone, Mongo, and scrape file counts.
- `GET /reindex/preview` -> dry-run of the ledger ingestion that reports adds, updates, and deletes without touching Pinecone.
- `GET /sources` -> list of saved scrape bundles with counts and categories.
- `GET /links` -> flattened view of the link database (PDFs, internal pages) once the system is initialized.
- `GET /test-gemini` / `GET /test-pinecone` -> connectivity probes for external services.

All endpoints return JSON. When `PORT` differs from 3000, update your curl/browser targets accordingly.

---

## Repository layout
```
server.js            # Express server + REST API + startup orchestration
scraper/scraper.js   # Puppeteer crawler (HTML discovery + JSON writer)
scraper/processPdfs.js # Standalone PDF text/OCR processor for scraped snapshots
RagSystem.js         # RAG pipeline (Gemini, Cohere, Pinecone, Mongo ledger, caches)
scripts/             # CLI helpers: scrape, embed, serve
caching/             # Embedding and response caches (Redis-backed with in-memory fallback)
public/              # Frontend assets served at /
scraped_data/        # Timestamped JSON snapshots from the scraper
testScraper.js       # Standalone scrape tester
docker-compose.yml   # Redis instance for local caching
```

---

## Operational notes
- **MongoDB optional but recommended**: with it, `_ingestWithLedger` tracks URL hashes, updates only changed content, and prunes stale vectors from Pinecone.
- **Redis optional**: improves latency by caching embeddings (`embeddingCache.js`) and full answers (`responseCache.js`). Without Redis the caches fall back to in-memory LRU storage and clear on restart.
- **Scraper limits**: defaults to six pages and depth three when run via the server. Increase CLI limits gradually to avoid hammering the source site.
- **Puppeteer dependencies**: the first `npm install` downloads Chromium. On headless servers set `PUPPETEER_SKIP_DOWNLOAD=true` and provide a Chrome/Chromium binary via `PUPPETEER_EXECUTABLE_PATH`.
- **Handling large scrapes**: Pinecone writes happen in batches; monitor logs for rate-limit warnings. If memory usage climbs, lower `chunkSize` or `maxPages` or run scrapes in stages.
- **Security**: never commit real `.env` values. Rotate API keys if they leak. Protect the Express app with auth, HTTPS, and rate limits before exposing it publicly.

---

## Troubleshooting
- `pdf-parse` errors -> ensure `test/data/05-versions-space.pdf` exists; reinstall dependencies; verify no system-level PDF tools are missing.
- `MongoDB not connected` warnings -> check `MONGODB_URI`. Without Mongo the system still answers but change tracking and `/embed-latest` ledger logic are skipped.
- `Pinecone index dimension` warning -> recreate the Pinecone index with dimension 1024 to match the Cohere model.
- Gemini or Cohere failures -> confirm API keys and model names (`gemini-2.5-flash`, `embed-english-v3.0`). Network egress must be allowed.
- Frontend stuck on "Initializing" -> confirm `/health` returns `initialized: true`. Otherwise POST `/initialize` or run `npm run embed` manually.
- Slow repeated questions -> run Redis (`docker compose up redis`) so the response cache can persist between requests.

---

Happy hacking! Once the stack runs locally you can tweak crawler limits, add new data sources, or swap providers as needed. `RagSystem.js` centralizes most of the integration code and is the best starting point for deeper changes.
