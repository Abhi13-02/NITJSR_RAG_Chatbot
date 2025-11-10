import { setupHealthRoutes } from './health.js';
import { setupSystemRoutes } from './system.js';
import { setupChatRoutes } from './chat.js';
import { setupScrapeRoutes } from './scrape.js';
import { setupDataRoutes } from './data.js';
import { setupStaticRoutes } from './static.js';


export function setupRoutes(app, server) {
    setupHealthRoutes(app, server);
    setupSystemRoutes(app, server);
    setupChatRoutes(app, server);
    setupScrapeRoutes(app, server);
    setupDataRoutes(app, server);
    setupStaticRoutes(app, server);
}