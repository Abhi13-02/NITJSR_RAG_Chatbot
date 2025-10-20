import 'dotenv/config';

// Ensure we don't auto-initialize when starting the server-only mode
if (!process.env.AUTO_INIT) {
  process.env.AUTO_INIT = 'false';
}

console.log('[serve] AUTO_INIT=', process.env.AUTO_INIT);
console.log('[serve] Starting server without auto initialization...');

// Importing server.js will start the server (it auto-starts when run/imported)
await import('../server.js');

