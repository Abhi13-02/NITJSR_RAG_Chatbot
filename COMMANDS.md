Commands                                                                                                                                                                 
                                                                                                                                                                           
  - Scrape only                                                                                                                                                            
      - npm run scrape                                                                                                                                                     
      - Options:                                                                                                                                                           
          - --maxPages N (default 250)                                                                                                                                     
          - --maxDepth N (default 4)                                                                                                                                       
          - --delay ms (default 1000)                                                                                                                                      
      - Example: npm run scrape -- --maxPages 200 --maxDepth 3                                                                                                             
      - Output: A JSON file saved under scraped_data/ with a timestamped name.                                                                                             
  - Embed + upload only (uses existing scraped JSON)                                                                                                                       
      - npm run embed                                                                                                                                                      
      - Options:                                                                                                                                                           
          - --file path/to/data.json (explicit file)                                                                                                                       
          - --latest (default; picks most recent JSON from scraped_data)                                                                                                   
          - --force (clears Pinecone index before upload)                                                                                                                  
      - Examples:                                                                                                                                                          
          - Latest: npm run embed                                                                                                                                          
          - Specific file: npm run embed -- --file scraped_data/nitjsr_enhanced_comprehensive_2025_10_19_17_05_42.json                                                     
          - Force clear: npm run embed -- --latest --force                                                                                                                 
  - Serve only (don’t auto-scrape/auto-embed)                                                                                                                              
      - npm run serve                                                                                                                                                      
      - Behavior: Starts server with AUTO_INIT=false, so it won’t scrape or process on boot. Use POST /initialize later if needed.                                         
      - Health check: http://localhost:3000/health                                                                                                                         
      - Manual init (optional): curl -X POST http://localhost:3000/initialize                                                                                              
  - All-in-one legacy behavior                                                                                                                                             
      - npm start (or npm run dev): starts server and auto-initializes                                                                                                     
          - If no scraped data exists: scrapes, embeds, uploads, then serves.                                                                                              
          - If data exists: processes and upserts it again (ids are stable, so it upserts rather than duplicating).                                                        
                                                                                                                                                                           
  Caching details                                                                                                                                                          
                                                                                                                                                                           
  - Embedding cache is used for query embeddings in RagSystem.js via caching/embeddingCache.js.                                                                            
      - Redis-backed if REDIS_URL is set; otherwise in-memory LRU fallback.                                                                                                
      - Check stats at /health under embeddingCache.                                                                                                                       
  - You can test the embedding cache utilities:                                                                                                                            
      - npm run test:redis-emb-cache                                                                                                                                       
      - npm run inspect:redis-emb-key                                                                                                                                      
                                                                                                                                                                           
  Environment                                                                                                                                                              
                                                                                                                                                                           
  - Required: set in .env                                                                                                                                                  
      - GEMINI_API_KEY                                                                                                                                                     
      - COHERE_API_KEY                                                                                                                                                     
      - PINECONE_API_KEY                                                                                                                                                   
      - PINECONE_INDEX_NAME                                                                                                                                                
      - PINECONE_ENVIRONMENT (e.g., us-east-1-aws)                                                                                                                         
  - Optional:                                                                                                                                                              
      - REDIS_URL (for persistent embedding cache)                                                                                                                         
      - COHERE_EMBED_MODEL (default embed-english-v3.0)                                                                                                                    
                                                                                                                                                                           
  Endpoints to verify connectivity                                                                                                                                         
                                                                                                                                                                           
  - Test Pinecone: GET /test-pinecone
  - Test Gemini: GET /test-gemini
  - Health: GET /health
  - Chat: POST /chat with body { "question": "..." }

  Notes

  - scripts/serve.js sets AUTO_INIT=false and imports server.js so you can run the chatbot immediately when Pinecone already has vectors.
  - If you want to repopulate Pinecone from a specific scrape, use npm run embed with --file and optionally --force.
