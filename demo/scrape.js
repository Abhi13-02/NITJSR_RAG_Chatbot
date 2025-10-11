import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';
import { NITJSRScraper } from '../scraper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function scrapeSelected(urls, options = {}) {
  const {
    headless = 'new',
    delay = 800,
    disablePdf = true
  } = options;

  // Keep depth and maxPages minimal for demo
  const scraper = new NITJSRScraper({ maxPages: urls.length, maxDepth: 0, delay });

  // Initialize Puppeteer/browser once
  // Use existing initialize signature (no args expected)
  await scraper.initialize();

  try {
    for (const url of urls) {
      try {
        await scraper.scrapePage(url, 0);
      } catch (e) {
        console.warn(`Skip failed page: ${url} -> ${e.message}`);
      }
    }

    // Optionally skip PDFs to avoid heavy processing on demo
    if (!disablePdf) {
      await scraper.processPDFDocuments();
    }

    // Update stats and persist a demo-specific file
    scraper.updateStatistics();
    const data = scraper.scrapedData;
    data.metadata.scrapeType = 'demo_selected';
    data.metadata.pageCountTarget = urls.length;

    const outDir = path.join(__dirname, 'data');
    await fs.mkdir(outDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '_');
    const outPath = path.join(outDir, `nitjsr_demo_${timestamp}.json`);
    await fs.writeFile(outPath, JSON.stringify(data, null, 2), 'utf8');

    console.log(`Saved demo scrape to: ${outPath}`);
    console.log(`Pages: ${data.statistics.totalPages}, PDFs: ${data.statistics.totalPDFs}`);
    return outPath;
  } finally {
    await scraper.cleanup();
  }
}

async function main() {
  const pagesFile = process.argv.find(a => a.startsWith('--pages='))?.split('=')[1]
    || path.join(__dirname, 'pages.json');
  const disablePdf = !process.argv.includes('--include-pdf');

  const urls = JSON.parse(await fs.readFile(pagesFile, 'utf8'));
  console.log(`Scraping ${urls.length} selected pages from ${pagesFile} ...`);
  await scrapeSelected(urls, { disablePdf });
}

if (import.meta.url === pathToFileURL(__filename).href) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export { scrapeSelected };
