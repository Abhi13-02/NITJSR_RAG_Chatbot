import 'dotenv/config';
import { NITJSRScraper } from '../scraper/scraper.js';

function parseArgs(argv) {
  const args = { maxPages: 20, maxDepth: 4, delay: 1500 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--maxPages' && argv[i + 1]) args.maxPages = Number(argv[++i]);
    else if (a === '--maxDepth' && argv[i + 1]) args.maxDepth = Number(argv[++i]);
    else if (a === '--delay' && argv[i + 1]) args.delay = Number(argv[++i]);
    else if (a === '--priority' && argv[i + 1]) {
      const list = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length) args.priorityUrls = list;
    } else if (a === '--exclude' && argv[i + 1]) {
      const list = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length) args.excludeUrls = list;
    }
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

