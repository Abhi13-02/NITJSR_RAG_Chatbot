# Commands & Shortcuts

Quick reference for the scripts and CLI flows that drive the NITJSR RAG stack.

---

## Core workflow
- **Install dependencies**
  ```bash
  npm install
  ```
- **Scrape fresh content**
  ```bash
  npm run scrape -- --maxPages 100 --maxDepth 3 --delay 1500
  ```
  - Defaults: `maxPages=9`, `maxDepth=4`, `delay=1500` ms (see `scripts/scrape.js`).
  - Output: `scraped_data/nitjsr_enhanced_comprehensive_<timestamp>.json`.
- **Embed into Pinecone**
  ```bash
  npm run embed -- --latest
  npm run embed -- --file scraped_data/<filename>.json
  npm run embed -- --latest --force      # clears Pinecone before reuploading
  ```
  - Requires Pinecone and Cohere credentials.
  - Needs MongoDB for the change-ledger ingestion path; falls back to legacy mode otherwise.
- **Serve the chatbot**
  ```bash
  npm run dev        # nodemon watch, auto-init honoured
  npm start          # single-run server with auto-init
  npm run serve      # server only, forces AUTO_INIT=false
  ```
  The server binds to `PORT` from `.env` (3000 if unset).

---

## Helpful API curls
- Initialize manually (if AUTO_INIT=false):
  ```bash
  curl -X POST http://localhost:3000/initialize
  ```
- Trigger scrape and embed from the server:
  ```bash
  curl -X POST http://localhost:3000/scrape -H "Content-Type: application/json" -d '{"force":false}'
  ```
- Ask a question:
  ```bash
  curl -X POST http://localhost:3000/chat \
       -H "Content-Type: application/json" \
       -d '{"question":"What are the latest placement stats for CSE?"}'
  ```
- Inspect stats and health:
  ```bash
  curl http://localhost:3000/health
  curl http://localhost:3000/stats
  curl http://localhost:3000/reindex/preview
  curl http://localhost:3000/sources
  ```
  Adjust the host or port if you changed `PORT`.

---

## Optional services
- **Redis (response and embedding cache)**
  ```bash
  docker compose up -d redis
  docker compose logs -f redis
  docker compose stop redis
  ```
- **MongoDB change ledger**
  - Provide `MONGODB_URI`, `MONGODB_DB`, `MONGO_PAGES_COLL`, `MONGO_CHUNKS_COLL` in `.env`.
  - Use `mongosh` or your preferred GUI to inspect the collections (`pages` and `chunks` by default).

---

## Diagnostics and utilities
- **Test scraper without the full pipeline**
  ```bash
  node testScraper.js
  ```
  Scrapes five pages at depth one, prints a summary, and saves JSON to `scraped_data/`.
- **Embedding cache inspection**
  ```bash
  npm run test:redis-emb-cache
  npm run inspect:redis-emb-key
  ```
- **Serve static frontend only (without the Node backend)**
  - Open `public/index.html` with a static server and set `window.API_BASE` in the browser console to point at your API host.
- **Shut down the server gracefully** -> send `Ctrl+C` or `kill` the process; `server.js` handles cleanup of Mongo connections.

---

Keep secrets in `.env`, not in commands. Most scripts pass options after `--` so npm does not swallow them.
