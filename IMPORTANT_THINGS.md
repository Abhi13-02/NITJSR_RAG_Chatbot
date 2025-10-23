# Important Things

- **Protect your secrets**  
  Create your own `.env` locally and keep it out of version control. Rotate Gemini, Cohere, Pinecone, Mongo, and Redis credentials immediately if they leak.

- **Match embedding models to stored vectors**  
  Cohere embeddings default to `embed-english-v3.0` (dimension 1024). If you switch models, clear the embedding cache, response cache, Mongo ledger, and Pinecone index (`npm run embed -- --latest --force`) so mixed vectors do not pollute similarity search.

- **MongoDB unlocks change tracking**  
  With `MONGODB_URI` configured, ingestion runs through `_ingestWithLedger`. It deduplicates by URL hash, stores chunk metadata, and removes stale vectors. Without Mongo the system falls back to a legacy "blind upsert"; expect slower re-embeds and no delete handling.

- **Redis is optional but recommended**  
  `REDIS_URL` enables durable caches for embeddings (`caching/embeddingCache.js`) and generated answers (`caching/responseCache.js`). Without Redis the caches drop to in-memory LRU and reset on every restart.

- **Auto-initialisation control**  
  `AUTO_INIT=true` (default) makes the server call `/initialize` on startup. Use `npm run serve` or set `AUTO_INIT=false` when you only want the API to serve existing Pinecone data.

- **Force a manual init from the UI**  
  The web client boot sequence calls `/initialize` when `/health` reports `initialized: false`. To disable that behaviour, set `window.DISABLE_AUTO_INIT = true` before the frontend scripts load or append `?noinit=1` to the page URL.

- **Scraper etiquette**  
  Respect the default `delay` (1.5 s) and limit `maxPages` when experimenting. Increase gradually and monitor logs to avoid overwhelming `nitjsr.ac.in`. PDFs are fetched via Axios; large documents will extend runtime.

- **Keep Pinecone aligned**  
  Ensure the Pinecone index uses cosine similarity and dimension 1024. Recreate the index if logs warn about a dimension mismatch.

- **Frontdoor hardening**  
  The Express server currently has no authentication or rate limiting. Place it behind a reverse proxy, add HTTPS, and gate POST endpoints before deploying publicly.

- **Binary dependencies**  
  Puppeteer downloads Chromium during `npm install`. In containerised environments set `PUPPETEER_SKIP_DOWNLOAD=true` and supply a Chrome or Chromium binary via `PUPPETEER_EXECUTABLE_PATH`.
