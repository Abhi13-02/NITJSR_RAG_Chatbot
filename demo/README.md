Demo Workflow (Selective Scrape + RAG)

What this adds
- A minimal “demo” pipeline that scrapes only selected URLs, optionally embeds them, and serves a small API that can run in two modes: local (no embeddings/Pinecone) and vector (uses Pinecone + Gemini embeddings).
- All files live in the demo/ folder and reuse the existing scraper and RAG logic.

Files
- demo/pages.json: The curated list of URLs for the demo.
- demo/scrape.js: Scrapes only the URLs in pages.json and saves JSON to demo/data/.
- demo/embed.js: Reads the latest demo data file and upserts a small set to Pinecone using Gemini embeddings.
- demo/AltRagSystem.js: Demo RAG system using free local embeddings via @xenova/transformers (MiniLM-L6-v2, 384 dims) + Gemini for generation.
- demo/server.js: Demo API server that mirrors the main server endpoints but operates on the selected demo pages. Endpoints: POST /initialize, POST /chat, POST /scrape, GET /health, /stats, /sources, /links. Includes automatic local-fallback mode if embedding quota is exceeded.
- demo/retrieve.js: CLI to query the latest demo data in local or vector mode.
- demo/server-reuse.js: Minimal server that reuses existing Pinecone vectors only (no scraping/embedding). Endpoints: POST /chat, GET /health, /stats, /links.

How to use
1) Scrape selected pages (no PDFs by default)
   node demo/scrape.js
   - To include PDFs: node demo/scrape.js --include-pdf

2) Optional: Create embeddings for vector mode (requires GEMINI + PINECONE env)
   node demo/embed.js
   - To include PDFs in embeddings: node demo/embed.js --include-pdf

3) Run the demo server (same contract as main server)
   node demo/server.js
   # Reuse existing Pinecone vectors (skip scraping + embedding):
   curl -X POST http://localhost:3300/initialize -H "Content-Type: application/json" -d '{"reuse":true}'
   # Or perform scrape+embed on the selected pages (may hit quota):
   curl -X POST http://localhost:3300/initialize
   curl -X POST http://localhost:3300/chat -H "Content-Type: application/json" -d '{"question":"Who are the wardens?"}'
   curl -X POST http://localhost:3300/scrape -H "Content-Type: application/json" -d '{"force":false,"includePdf":false}'

3b) Reuse-only server (skip scrape + embed; use existing Pinecone vectors)
   npm run demo:serve:reuse
   curl -X POST http://localhost:3300/chat -H "Content-Type: application/json" -d '{"question":"Tell me about NITJSR rankings"}'

4) CLI retrieval without server (optional tooling)
   Local-only demo (no vector DB): node demo/retrieve.js --mode=local --q="How to reach NIT JSR?"
   Vector mode (after demo:embed): node demo/retrieve.js --mode=vector --q="Faculty details for CS115"

Environment
- Required for demo server: GEMINI_API_KEY (generation), PINECONE_API_KEY, PINECONE_INDEX_NAME (base), PINECONE_ENVIRONMENT.
- Controls: DEMO_MAX_PAGES (default 5), DEMO_MAX_CHARS (default 4000), DEMO_INCLUDE_PDF=1 to include PDFs.
- If embeddings fail (429/quota), server auto-switches to local-fallback and still answers via keyword search. The /chat response includes mode: "local-fallback".

Pinecone index for local embeddings
- The demo uses a separate index with 384 dimensions. Set `PINECONE_INDEX_NAME_ALT` to choose a name. If not set, it uses `${PINECONE_INDEX_NAME}-local`.
  The first run downloads the model from Hugging Face (free) and caches it locally.

Gemini model selection
- Set `DEMO_GEN_MODEL` to force a specific Gemini model ID.
- The demo tries, in order: `DEMO_GEN_MODEL` → `gemini-1.5-flash` → `gemini-1.5-flash-latest` → `gemini-1.5-flash-8b` → `gemini-1.0-pro` → `gemini-pro`.
- If your key doesn’t have access to 1.5 Flash, try `gemini-1.0-pro`.

Notes
- Local mode deliberately avoids embeddings and Pinecone. It’s fast for demos and works with free-tier limits.
- Vector mode is the same pipeline as the main server but with a tiny document set.
