import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { UrlHelpers } from './urlHelpers.js';
import { PageCategorizer } from './categories.js';
import { PdfPolicy } from './pdfs.js';
import { SitemapLoader } from './sitemapLoader.js';
import { XhrCapture } from './xhrCapture.js';
import { PageExtractor } from './pageExtractor.js';
import { LinkProcessor } from './linkProcessor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


class NITJSRScraper {
    constructor(options = {}) {
        this.visited = new Set();
        this.toVisit = new Set();
        this.pdfUrls = new Set();
        this.pdfUrlOriginals = new Map();
        this.maxPages = options.maxPages || 650;
        this.maxDepth = options.maxDepth || 3;
        this.delay = options.delay || 1500;
        this.baseUrl = 'https://nitjsr.ac.in';
        this.priorityUrls = Array.isArray(options.priorityUrls) ? options.priorityUrls : [];
        this.priorityQueue = [];
        this.excludeUrls = new Set();

        // Initialize helper classes
        this.browserManager = null;
        this.urlHelpers = new UrlHelpers(this.baseUrl);
        this.categorizer = new PageCategorizer(this.baseUrl);
        this.pdfPolicy = new PdfPolicy();
        this.pageExtractor = new PageExtractor();

        // Process exclude URLs
        if (Array.isArray(options.excludeUrls)) {
            options.excludeUrls.forEach((raw) => {
                try {
                    const normalized = this.urlHelpers.normalizeUrl(raw);
                    if (normalized) {
                        this.excludeUrls.add(normalized.toLowerCase());
                    }
                } catch {
                    // ignore invalid exclude URL
                }
            });
        }

        this.scrapedData = {
            metadata: {
                timestamp: new Date().toISOString(),
                source: 'NIT Jamshedpur Official Website',
                baseUrl: this.baseUrl,
                scrapeType: 'enhanced_comprehensive',
                maxPages: this.maxPages,
                maxDepth: this.maxDepth,
            },
            pages: [],
            documents: {
                pdfs: [],
            },
            links: {
                internal: [],
                external: [],
                pdf: [],
                image: [],
            },
            statistics: {
                totalPages: 0,
                totalPDFs: 0,
                totalImages: 0,
                totalLinks: 0,
                categorizedPages: 0,
            },
            pagePdfRanking: [],
        };

        // Initialize XHR capture and link processor (they need scrapedData)
        this.xhrCapture = new XhrCapture(
            this.urlHelpers,
            this.categorizer,
            this.pdfPolicy,
            this.scrapedData,
            this.pdfUrls,
            this.pdfUrlOriginals
        );

        // Sitemap loader will be initialized in scrapeComprehensive
        this.sitemapLoader = null;
    }

    async initialize() {
        if (!this.browserManager) {
            const { BrowserManager } = await import('./browserManager.js');
            this.browserManager = new BrowserManager();
        }

        await this.browserManager.initialize();
    }


    isExcluded(url) {
        const key = this.urlHelpers.normalizeForComparison(url);
        if (!key) return false;

        // check exact match or same with trailing slash
        if (this.excludeUrls.has(key)) return true;
        return this.excludeUrls.has(key.endsWith('/') ? key.slice(0, -1) : key + '/');

    }


    applyRuntimeOptions(runOptions = {}) {
        const options = runOptions && typeof runOptions === 'object' ? runOptions : {};
        const previousState = {
            maxPages: this.maxPages,
            maxDepth: this.maxDepth,
            priorityUrls: Array.isArray(this.priorityUrls) ? [...this.priorityUrls] : [],
            excludeUrls: new Set(this.excludeUrls),
            metadata: this.scrapedData?.metadata
                ? {
                    maxPages: this.scrapedData.metadata.maxPages,
                    maxDepth: this.scrapedData.metadata.maxDepth,
                }
                : null,
        };

        const parsePositiveInt = (value) => {
            const num = Number(value);
            if (!Number.isFinite(num)) return null;
            const intVal = Math.floor(num);
            return intVal > 0 ? intVal : null;
        };

        const overrideMaxPages = parsePositiveInt(options.maxPages);
        if (overrideMaxPages) {
            this.maxPages = overrideMaxPages;
            if (this.scrapedData?.metadata) {
                this.scrapedData.metadata.maxPages = overrideMaxPages;
            }
        }

        const depthInput = options.maxDepth ?? options.depth;
        const overrideDepth = parsePositiveInt(depthInput);
        if (overrideDepth) {
            this.maxDepth = overrideDepth;
            if (this.scrapedData?.metadata) {
                this.scrapedData.metadata.maxDepth = overrideDepth;
            }
        }

        const priorityList = this.urlHelpers.normalizeUrlCollection(
            options.priorityUrls ?? options.priorityUrl
        );
        if (priorityList.length > 0) {
            this.priorityUrls = priorityList;
        }

        const restrictedSeed =
            options.restrictedUrls ??
            options.restrictedUrl ??
            options.excludeUrls ??
            options.excludeUrl;
        const extraExclusions = this.urlHelpers.normalizeUrlCollection(restrictedSeed);
        if (extraExclusions.length > 0) {
            extraExclusions.forEach((url) => {
                const key =
                    this.urlHelpers.normalizeForComparison(url) || String(url || '').toLowerCase();
                if (key) {
                    this.excludeUrls.add(key);
                }
            });
        }

        return () => {
            this.maxPages = previousState.maxPages;
            this.maxDepth = previousState.maxDepth;
            this.priorityUrls = previousState.priorityUrls;
            this.excludeUrls = new Set(previousState.excludeUrls);
            if (previousState.metadata && this.scrapedData?.metadata) {
                this.scrapedData.metadata.maxPages = previousState.metadata.maxPages;
                this.scrapedData.metadata.maxDepth = previousState.metadata.maxDepth;
            }
        };
    }


    async scrapePage(url, depth = 0) {
        if (this.isExcluded(url)) {
            return null;
        }
        if (!this.urlHelpers.isValidUrl(url)) {
            return null;
        }
        const visitKey = this.urlHelpers.normalizeForComparison(url) || url;
        if (
            this.visited.has(visitKey) ||
            depth > this.maxDepth ||
            this.visited.size >= this.maxPages
        ) {
            return null;
        }

        console.log(
            `🔍 Scraping [${depth}/${this.maxDepth}] (${this.visited.size}/${this.maxPages}): ${url}`
        );
        this.visited.add(visitKey);

        await this.browserManager.ensurePage();

        const pageMeta = { title: '' };
        let detachXHR = this.xhrCapture.capturePageXHR(
            this.browserManager.page,
            url,
            pageMeta
        );
        let latestResolvedKey = null;

        try {
            await this.browserManager.page.goto(url, {
                waitUntil: 'networkidle0',
                timeout: 45000,
            });

            await this.browserManager.page.waitForTimeout(this.delay);

            pageMeta.title =
                (await this.browserManager.page.title().catch(() => '')) || '';

            let rawPageData = null;
            try {
                rawPageData = await this.pageExtractor.extractFullDom(this.browserManager.page);
            } catch {
                rawPageData = null;
            }

            const pageData = this.pageExtractor.normalizeDomData(rawPageData);

            pageMeta.title = pageData.title || pageMeta.title;
            const finalPageTitle = pageMeta.title;

            // Update titles in existing PDF records
            if (finalPageTitle) {
                this.scrapedData.links.pdf.forEach((link) => {
                    if (link.sourceUrl === url) {
                        link.sourceTitle = finalPageTitle;
                    }
                });
                this.scrapedData.documents.pdfs.forEach((pdf) => {
                    if (pdf.parentPageUrl === url) {
                        pdf.parentPageTitle = finalPageTitle;
                        if (Object.prototype.hasOwnProperty.call(pdf, 'sourceTitle')) {
                            pdf.sourceTitle = finalPageTitle;
                        }
                    }
                });
            }

            const currentSourceTitle = pageMeta.title;
            const extractedTables = Array.isArray(pageData.tables) ? pageData.tables : [];
            const tableTextContent = this.pageExtractor.extractTableTextContent(extractedTables);

            // Scroll page to load dynamic content
            await this.pageExtractor.scrollPage(this.browserManager.page);

            // Clean and process links
            pageData.links = this.pageExtractor.cleanLinks(pageData.links, url);

            const allContent = [
                pageData.title,
                ...pageData.headings.map((h) => h.text),
                ...pageData.content,
                ...tableTextContent,
                ...pageData.lists.flat(),
                pageData.metadata.description,
                pageData.metadata.keywords,
            ]
                .filter(Boolean)
                .join(' ');

            const cacheKey = this.urlHelpers.normalizeForComparison(url) || url;
            const resolvedUrl = this.browserManager.page.url();
            const resolvedKey = this.urlHelpers.normalizeForComparison(resolvedUrl) || resolvedUrl;
            latestResolvedKey = resolvedKey;

            const xhrEntries = this.xhrCapture.mergeXhrEntries(cacheKey, resolvedKey);

            const processedPage = {
                url: url,
                timestamp: new Date().toISOString(),
                depth: depth,
                title: pageData.title,
                headings: pageData.headings,
                content: allContent,
                rawContent: pageData.content,
                tables: extractedTables,
                lists: pageData.lists,
                metadata: pageData.metadata,
                xhrResponses: xhrEntries,
                category: this.categorizer.categorizeUrl(url, allContent),
                wordCount: allContent.split(' ').length,
            };

            this.scrapedData.pages.push(processedPage);
            console.log(
                `Page ${processedPage.url} -> ${processedPage.xhrResponses.length} XHR responses captured`
            );

            // Initialize link processor for this page
            const linkProcessor = new LinkProcessor(
                this.scrapedData,
                this.pdfUrls,
                this.pdfUrlOriginals,
                this.urlHelpers,
                this.categorizer,
                this.pdfPolicy,
                this.toVisit,
                this.visited,
                (url) => this.isExcluded(url)
            );

            linkProcessor.processLinks(pageData.links, url, depth, currentSourceTitle);

            const linkCounts = linkProcessor.getLinkCounts(url);

            // Track page PDF ranking
            this.scrapedData.pagePdfRanking.push({
                url,
                title: pageMeta.title || pageData?.title || '',
                pdfCount: linkCounts.pdfCount,
            });

            console.log(`[page-summary] ${url}
        PDFs found here: ${linkCounts.pdfCount}
        internal links: ${linkCounts.internalCount}
        external links: ${linkCounts.externalCount}
        total PDFs so far: ${this.scrapedData.documents.pdfs.length}
      `);

            console.log(
                `✅ Scraped: ${pageData.title} (${allContent.split(' ').length} words, ${
                    pageData.links.length
                } links)`
            );
            return processedPage;
        } catch (error) {
            console.error(`❌ Failed to scrape ${url}:`, error.message);
            // if the page/session died, recreate so the *next* URL won't also fail
            if (
                error.message &&
                (error.message.includes('Target closed') || error.message.includes('Session closed'))
            ) {
                try {
                    await this.browserManager.ensurePage();
                } catch (e) {
                    console.warn('⚠️ Failed to recreate page after crash:', e.message);
                }
            }
            return null;
        } finally {
            if (detachXHR) {
                detachXHR();
            }
            const cleanupKey = this.urlHelpers.normalizeForComparison(url) || url;
            if (cleanupKey) {
                this.xhrCapture.clearXhrForPage(cleanupKey);
            }
            if (latestResolvedKey && latestResolvedKey !== cleanupKey) {
                this.xhrCapture.clearXhrForPage(latestResolvedKey);
            }
        }
    }


    async scrapeComprehensive(runOptions = {}) {
        let restoreOptions = null;

        try {
            await this.initialize();

            restoreOptions = this.applyRuntimeOptions(runOptions);

            this.priorityQueue = [];

            const prioritySeen = new Set();

            this.priorityUrls.forEach((priorityUrl) => {
                try {
                    const fullUrl = this.urlHelpers.normalizeUrl(priorityUrl);

                    if (!fullUrl) return;
                    if (this.isExcluded(fullUrl)) return;
                    if (!this.urlHelpers.isValidUrl(fullUrl)) return;

                    const priorityKey = this.urlHelpers.normalizeForComparison(fullUrl) || fullUrl;

                    if (prioritySeen.has(priorityKey) || this.visited.has(priorityKey)) return;

                    prioritySeen.add(priorityKey);

                    const entry = { url: fullUrl, depth: 0 };

                    this.priorityQueue.push(entry);
                    this.toVisit.add(entry);
                } catch {
                    // ignore invalid priority URL
                }
            });

            const startUrls = ['https://nitjsr.ac.in/'];

            // Add starting URLs to visit queue
            startUrls.forEach((url) => {
                const normalized = this.urlHelpers.normalizeUrl(url);

                if (!normalized) return;
                if (this.isExcluded(normalized)) return;

                const startKey = this.urlHelpers.normalizeForComparison(normalized);

                if (startKey && this.visited.has(startKey)) return;

                this.toVisit.add({ url: normalized, depth: 0 });
            });

            // Initialize sitemap loader and load URLs
            this.sitemapLoader = new SitemapLoader(
                this.baseUrl,
                this.urlHelpers,
                this.pdfPolicy,
                this.categorizer
            );
            await this.sitemapLoader.loadSitemapUrls(
                this.visited,
                this.toVisit,
                (url) => this.isExcluded(url)
            );

            console.log(
                `Starting enhanced comprehensive scrape of ${startUrls.length} main sections...`
            );

            while (
                (this.priorityQueue.length > 0 || this.toVisit.size > 0) &&
                this.visited.size < this.maxPages
                ) {
                let nextEntry = null;

                if (this.priorityQueue.length > 0) {
                    nextEntry = this.priorityQueue.shift();

                    for (const candidate of this.toVisit) {
                        if (candidate.url === nextEntry.url) {
                            this.toVisit.delete(candidate);
                            break;
                        }
                    }
                } else {
                    const iterator = this.toVisit.values().next();

                    if (iterator.done) break;

                    nextEntry = iterator.value;

                    this.toVisit.delete(nextEntry);
                }

                if (!nextEntry) continue;

                const { url, depth } = nextEntry;

                if (this.isExcluded(url)) {
                    continue;
                }

                await this.scrapePage(url, depth);

                if (this.visited.size % 20 === 0) {
                    console.log(
                        `📊 Progress: ${this.visited.size}/${this.maxPages} pages scraped, ${this.pdfUrls.size} PDFs found`
                    );
                }
            }

            this.updateStatistics();

            const result = await this.saveData();

            return result;
        } catch (error) {
            console.error('❌ Enhanced comprehensive scraping failed:', error.message);
        } finally {
            if (typeof restoreOptions === 'function') {
                try {
                    restoreOptions();
                } catch (restoreError) {
                    console.warn(
                        'Failed to restore scraper options:',
                        restoreError?.message || restoreError
                    );
                }
            }

            await this.cleanup();
        }
    }


    updateStatistics() {
        this.scrapedData.statistics.totalPages = this.scrapedData.pages.length;
        this.scrapedData.statistics.totalPDFs = this.scrapedData.documents.pdfs.length;
        this.scrapedData.statistics.totalLinks =
            this.scrapedData.links.internal.length +
            this.scrapedData.links.external.length +
            this.scrapedData.links.pdf.length +
            this.scrapedData.links.image.length;
        this.scrapedData.statistics.categorizedPages = this.scrapedData.pages.length;

        // Sort page PDF ranking by count descending
        if (Array.isArray(this.scrapedData.pagePdfRanking)) {
            this.scrapedData.pagePdfRanking.sort((a, b) => b.pdfCount - a.pdfCount);
        }
    }


    async saveData() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '_');
        const filename = `nitjsr_enhanced_comprehensive_${timestamp}.json`;
        const filepath = path.resolve(__dirname, '..', 'scraped_data', filename);

        // Ensure directory exists
        await fs.mkdir(path.dirname(filepath), { recursive: true });

        // Save the data
        await fs.writeFile(filepath, JSON.stringify(this.scrapedData, null, 2), 'utf8');

        const categoryCounts = this.scrapedData.pages.reduce((acc, page) => {
            const key = page.category || 'general';
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});

        const summary = {
            filename: filename,
            timestamp: new Date().toISOString(),
            totalPages: this.scrapedData.statistics.totalPages,
            totalPDFs: this.scrapedData.statistics.totalPDFs,
            totalLinks: this.scrapedData.statistics.totalLinks,
            categories: Object.entries(categoryCounts).map(([name, count]) => ({
                name,
                count,
            })),
            pdfBreakdown: this.scrapedData.documents.pdfs.map((pdf) => ({
                title: pdf.title,
                pages: pdf.pages,
                wordCount: pdf.wordCount,
                category: pdf.category,
            })),
            filepath: filepath,
        };

        console.log(`💾 Data saved to: ${filepath}`);
        console.log(
            `📊 Summary: ${summary.totalPages} pages, ${summary.totalPDFs} PDFs, ${summary.totalLinks} links`
        );

        return { summary, filepath, data: this.scrapedData };
    }


    async cleanup() {
        if (this.browserManager) {
            await this.browserManager.cleanup();
        }
    }

}

export { NITJSRScraper };
