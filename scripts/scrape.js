import 'dotenv/config';
import { NITJSRScraper } from '../scraper.js';

function parseArgs(argv) {
  const args = { maxPages: 250, maxDepth: 4, delay: 1000 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--maxPages' && argv[i + 1]) args.maxPages = Number(argv[++i]);
    else if (a === '--maxDepth' && argv[i + 1]) args.maxDepth = Number(argv[++i]);
    else if (a === '--delay' && argv[i + 1]) args.delay = Number(argv[++i]);
  }
  return args;
}

async function main() {
  const opts = parseArgs(process.argv);
  console.log(`[scrape] Starting scrape with maxPages=${opts.maxPages}, maxDepth=${opts.maxDepth}, delay=${opts.delay}ms`);

  const scraper = new NITJSRScraper(opts);
  const result = await scraper.scrapeComprehensive();

  console.log('[scrape] Done.');
  console.log('[scrape] Summary:', result.summary);
  console.log('[scrape] Saved to:', result.filepath);
}

main().catch((e) => {
  console.error('[scrape] Failed:', e?.message || e);
  process.exit(1);
});

