# NIT Jamshedpur RAG Chatbot
# NIT Jamshedpur RAG Chatbot

AI assistant that answers questions about NIT Jamshedpur using Retrieval‑Augmented Generation (RAG). It crawls the official website, extracts and embeds content, and serves accurate, source‑grounded answers with relevant links and streaming responses.

— Built for reliability, speed, and maintainability. Perfect for demos, interviews, and real users.


**Why it stands out**
- End‑to‑end RAG: scraper → embedding → vector search → streaming answers
- Uses Google Gemini for generation and Cohere for embeddings
- Vector search on Pinecone; MongoDB ledger for change tracking and safe re‑ingestion
- Production‑minded: rate limiting, Redis caches, and SSE streaming
- Smart scraper with Puppeteer + sitemap policy to prioritize fresh tenders/notices and PDFs


**Live Experience (local)**
- Chat UI: `http://localhost:3000/`
- Admin/Docs page: `http://localhost:3000/admin`
- Health: `http://localhost:3000/health`
- Stats: `http://localhost:3000/stats`


## Overview

The system implements a pragmatic RAG architecture tailored for the NIT Jamshedpur website:

- Scrape the site with Puppeteer, collect rich page content and PDF links, and persist snapshots under `scraped_data/`.
- Chunk and embed with Cohere; store semantic vectors in Pinecone.
- Maintain a change ledger in MongoDB (per URL content hash) to avoid duplicate work and to safely delete stale vectors.
- Serve chat with Google Gemini; retrieve top‑K relevant chunks and stream answers via Server‑Sent Events (SSE).
- Cache heavy work: embedding cache and a semantic response cache using LSH (Redis‑backed or in‑memory fallback).
- Enforce rate limits per session/IP using Redis or memory fallback.


## Architecture

- Scraper: Puppeteer + Axios with sitemap awareness, categorized page discovery, dynamic JSON/XHR parsing and PDF link extraction.
- Embeddings: Cohere v3 (`1024`‑dim) via LangChain.
- Vector Store: Pinecone (cosine similarity, dimension 1024).
- Generation: Google Gemini (`gemini‑2.5‑flash`) with structured prompt and context window from vector search.
- Change Ledger: MongoDB collections `pages` and `chunks` track content hashes, chunk IDs, and versions.
- Caches:
  - Embedding cache (`caching/embeddingCache.js`) — Redis or in‑memory LRU
  - Response cache (`caching/responseCache.js`) — LSH over embeddings to reuse similar answers
- API & Streaming: Express with SSE on `/chat-stream`, plus admin endpoints for scraping/embedding/health.
- Rate Limiting: Redis‑based limiter with memory fallback.


## Tech Stack

- Node.js (ESM), Express, CORS
- Google Generative AI (Gemini)
- Cohere Embeddings via LangChain
- Pinecone Vector Database
- MongoDB (change ledger)
- Redis (optional) for caching and rate limiting
- Puppeteer (scraper), Axios, Cheerio‑style parsing (via DOM evaluation)
- Frontend: simple HTML/CSS/JS served from `public/` with a clean chat UI


## Repository Layout

- `server.js` — Express server, routes, startup and lifecycle
- `rag-system/RagSystem.js` — RAG core (init, retrieval, streaming chat, ledger ingestion)
- `scraper/scraper.js` — Puppeteer scraper with sitemap and PDF policy
- `scraper/processPdfs.js` — PDF processing helpers
- `caching/` — embedding and response caches, normalization, and chat history
- `rate-limiting/rateLimiter.js` — per‑session/IP limiter (Redis/memory)
- `scripts/` — CLI flows for `scrape`, `embed`, `serve`
- `public/` — chat UI and admin reference page
- `scraped_data/` — persisted scrape snapshots (JSON)


## Getting Started

Prerequisites
- Node.js 18+
- Pinecone account (index with dimension 1024, cosine)
- Cohere API key
- Google Gemini API key
- MongoDB (recommended) for change ledger
- Redis (optional) for durable caches

Install
- `npm install`

Environment
Create a `.env` file (do not commit secrets):

```
PORT=3000
NODE_ENV=development

# AI Providers
GEMINI_API_KEY=...
COHERE_API_KEY=...
COHERE_EMBED_MODEL=embed-english-v3.0

# Pinecone
PINECONE_API_KEY=...
PINECONE_ENVIRONMENT=us-east-1
PINECONE_INDEX_NAME=nitjsrchatbot

# MongoDB (recommended)
MONGODB_URI=...
MONGODB_DB=nitjsr_rag
MONGO_PAGES_COLL=pages
MONGO_CHUNKS_COLL=chunks

# Redis (optional)
REDIS_URL=redis://localhost:6379

# Response cache tuning (optional)
RESPONSE_CACHE_TTL_SECONDS=604800
RESPONSE_CACHE_LSH_BITS=16
RESPONSE_CACHE_LSH_RADIUS=1
RESPONSE_CACHE_SIM_THRESHOLD=0.92
RESPONSE_CACHE_MAX_CANDIDATES=200

# Control auto‑initialization at boot
AUTO_INIT=true
```

Run the core workflow
1) Scrape content
- `npm run scrape -- --maxPages 100 --maxDepth 3 --delay 1500`
  - Output JSON is saved to `scraped_data/`.
2) Embed into Pinecone (requires MongoDB for the ledger path)
- `npm run embed -- --latest`
- `npm run embed -- --latest --force` (clears Pinecone first)
3) Serve the chatbot
- `npm run dev` (nodemon) or `npm start`
- `npm run serve` to start without auto‑initialization (set `AUTO_INIT=false`)


## Key Endpoints

- `POST /initialize` — Validate env and initialize the RAG system
- `POST /chat-stream` — Streamed chat responses (SSE). Send `{ question, sessionId }`
- `POST /scrape` — Scrape website; accepts overrides like `maxPages`, `maxDepth`
- `POST /scrape-and-embed` — Scrape then embed into Pinecone
- `POST /embed-latest` — Embed the most recent snapshot from `scraped_data/`
- `POST /reset-storage` — Clear Pinecone and Mongo collections
- `GET /health` — Status, caches, index stats, Mongo status
- `GET /stats` — Summary including data files and cache stats
- `GET /sources` — Overview of available scraped snapshots
- `GET /links` — All discovered links (pdf, page, etc.) once initialized


## Data Flow

1) Discovery & Scrape
- Sitemap‑aware crawler discovers section pages and recent tender/notice PDFs.
- Page DOM is filtered for main content; tables and lists are captured.
- JSON/XHR responses are inspected to capture PDFs linked indirectly.

2) Ingestion & Embedding
- Text is split into overlapping chunks (LangChain splitter).
- Cohere embeddings (v3, 1024‑dim) are computed with a cache.
- Pinecone upserts chunks; Mongo ledger tracks content hashes and versions.
- Stale chunks are pruned safely using the ledger plan.

3) Query & Generation
- For each user question, top‑K chunks are retrieved from Pinecone.
- A structured prompt is sent to Gemini; response is streamed via SSE.
- Response cache can short‑circuit if a highly similar question was answered recently.


## Performance & Reliability

- Cohere embeddings cached to reduce model calls
- Response cache uses LSH buckets in Redis or memory for fast approximate lookups
- Mongo change ledger prevents duplicate embeddings and handles deletes
- Rate limiter protects `/chat-stream` with Redis/memory backend
- SSE streaming improves perceived latency for users


## Security & Deployment Notes

- Never commit `.env` with secrets. Rotate leaked keys immediately.
- Put the service behind HTTPS and a reverse proxy (e.g., NGINX); enable authentication on admin endpoints if exposed.
- Pin Pinecone index to 1024 dimensions for Cohere v3; recreate if misconfigured.
- Production: prefer Redis for caches and enable Mongo ledger; consider VPC‑peered services where available.


## What Recruiters Should Notice

- System thinking: end‑to‑end design from data acquisition to answer delivery
- Practical tradeoffs: fast iteration, robust defaults, and operational safeguards
- Clear separation of concerns: scraper, RAG core, caching, rate limiting, and UI
- Maintainability: change‑ledger approach, metrics endpoints, and CLI scripts
- Production empathy: caching layers, rate limiting, and graceful startup/shutdown


## Roadmap (Next Steps)

- Add evaluation harness for answer quality (groundedness, factuality)
- Add auth and role‑based access for admin endpoints
- Support hybrid retrieval (keyword + vector)
- Improve PDF parsing pipeline and document chunking heuristics
- Add observability (tracing and structured metrics)


## Quick Commands

- Install: `npm install`
- Scrape: `npm run scrape -- --maxPages 100 --maxDepth 3`
- Embed: `npm run embed -- --latest` (use `--force` to clear index)
- Serve: `npm run dev` or `npm start`
- No auto‑init: `npm run serve` (sets `AUTO_INIT=false`)


## Credits

- Google Generative AI (Gemini) for generation
- Cohere + LangChain for embeddings
- Pinecone for vector search
- Puppeteer for scraping
- Redis and MongoDB for caching and ledgering


— If you’d like a tour of the codebase or a live demo, just ask. 

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
rag-system/RagSystem.js # RAG pipeline (Gemini, Cohere, Pinecone, Mongo ledger, caches)
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

Happy hacking! Once the stack runs locally you can tweak crawler limits, add new data sources, or swap providers as needed. `rag-system/RagSystem.js` centralizes most of the integration code and is the best starting point for deeper changes.
