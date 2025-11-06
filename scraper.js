import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import puppeteer from 'puppeteer';
import axios from 'axios';
import pdfParse from 'pdf-parse';
import zlib from 'zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class NITJSRScraper {
    constructor(options = {}) {
        this.browser = null;
        this.page = null;
        this.visited = new Set();
        this.toVisit = new Set();
        this.pdfUrls = new Set();
        this.maxPages = options.maxPages || 5;   // Increased limit
        this.maxDepth = options.maxDepth || 3;   // Deeper crawling
        this.delay = options.delay || 1500;
        this.baseUrl = 'https://nitjsr.ac.in';
        this.priorityUrls = Array.isArray(options.priorityUrls) ? options.priorityUrls : ['https://www.nitjsr.ac.in/Notices/Archive_Notices'];
        this.priorityQueue = [];
        this.pageXHRCache = new Map();
        this.excludeUrls = new Set(['https://nitjsr.ac.in']);
        if (Array.isArray(options.excludeUrls)) {
            options.excludeUrls.forEach(raw => {
                try {
                    const normalized = this.normalizeUrl(raw);
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
                maxDepth: this.maxDepth
            },
            pages: [],
            documents: {
                pdfs: []
            },
            links: {
                internal: [],
                external: [],
                pdf: [],
                image: []
            },
            statistics: {
                totalPages: 0,
                totalPDFs: 0,
                totalImages: 0,
                totalLinks: 0,
                categorizedPages: 0
            }
        };
    }

    async initialize() {
        console.log('🚀 Initializing NIT JSR Website Scraper...');
        if (!puppeteer) {
            console.warn('⚠️ Puppeteer not available, scraper will work with limited functionality');
            return;
        }
        
        this.browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor',
            ]
        });
        this.page = await this.browser.newPage();
        
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await this.page.setViewport({ width: 1920, height: 1080 });
        
        await this.page.setJavaScriptEnabled(true);
        
        console.log('✅ Enhanced scraper initialized successfully');
    }

    categorizeUrl(url, content = '') {
        // --- Smarter, resilient categorization ---
        const CATEGORY_SEGMENT_MAP = {
            institute: 'institute',
            administration: 'administration',
            academics: 'academics',
            academic: 'academics',           // catch singular
            students: 'students',
            student: 'students',
            research: 'research',
            people: 'people',
            tender: 'tender',
            tenders: 'tender',
            notices: 'notices',
            notice: 'notices',
            cells: 'cells',
            cell: 'cells',
            facilities: 'facilities',
            facility: 'facilities',
            recruitments: 'recruitments',
            recruitment: 'recruitments',
            rti: 'rti',
            'computer-center': 'computer_center',
            'computer_center': 'computer_center',
            'central-facilities': 'facilities',
            'central_facilities': 'facilities'
        };

        // helper: get first path segment from URL
        const getFirstSegment = (url) => {
            try {
                const u = new URL(url, this.baseUrl || 'https://nitjsr.ac.in');
                const seg = u.pathname.split('/').filter(Boolean)[0];
                return seg ? seg.toLowerCase() : '';
            } catch {
                return '';
            }
        };

        // helper: content-based fallback
        const guessFromContent = (text = '') => {
            const checks = [
                { key: 'academics', rx: /\b(curriculum|syllabus|semester|academic|course|b\.?tech|m\.?tech|ph\.?d)\b/i },
                { key: 'students', rx: /\b(admission|hostel|scholarship|student|exam|result|anti[-\s]?ragging)\b/i },
                { key: 'research', rx: /\b(research|publication|project|grant|patent)\b/i },
                { key: 'recruitments', rx: /\b(recruitment|walk[-\s]?in|faculty|advertisement)\b/i },
                { key: 'tender', rx: /\b(tender|gem\b|bidding|quotation|procurement)\b/i },
                { key: 'notices', rx: /\b(notice|notification|announcement|circular)\b/i },
                { key: 'facilities', rx: /\b(library|laborator(y|ies)|workshop|sports|medical|guest\s*house)\b/i },
                { key: 'administration', rx: /\b(registrar|dean|administration|establishment|senate)\b/i }
            ];
            for (const { key, rx } of checks) if (rx.test(text)) return key;
            return null;
        };

        // 1) Try URL-based
        const seg = getFirstSegment(url);
        if (CATEGORY_SEGMENT_MAP[seg]) return CATEGORY_SEGMENT_MAP[seg];

        // 2) Try removing plural (academics -> academic)
        const singular = seg.endsWith('s') ? seg.slice(0, -1) : null;
        if (singular && CATEGORY_SEGMENT_MAP[singular]) return CATEGORY_SEGMENT_MAP[singular];

        // 3) Fallback on content analysis
        const fromContent = guessFromContent(content);
        if (fromContent) return fromContent;

        // 4) Default
        return 'general';
    }

    isValidUrl(url) {
        try {
            const urlObj = new URL(url, this.baseUrl);
            
            // Only scrape nitjsr.ac.in domain
            if (!urlObj.hostname.includes('nitjsr.ac.in')) {
                return false;
            }
            
            // Skip certain file types and external links
            const skipExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.css', '.js', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.map'];
            const skipPatterns = [
                'mailto:', 'tel:', 'javascript:', '#',
                '/assets/', '/static/', '/locales/', '/images/', '/fonts/',
                'facebook.com', 'twitter.com', 'linkedin.com', 'youtube.com',
                'google.com', 'maps.google', 'instagram.com'
            ];
            
            const pathname = urlObj.pathname.toLowerCase();
            const full = url.toLowerCase();
            
            if (skipExtensions.some(ext => pathname.endsWith(ext))) return false;
            if (skipPatterns.some(pattern => full.includes(pattern))) return false;
            
            return true;
        } catch {
            return false;
        }
    }

    normalizeUrl(url) {
        try {
            return new URL(url, this.baseUrl).href;
        } catch {
            return null;
        }
    }

    normalizeForComparison(url) {
        const normalized = this.normalizeUrl(url);
        return normalized ? normalized.toLowerCase() : null;
    }

    isExcluded(url) {
        const key = this.normalizeForComparison(url);
        if (!key) return false;

        // check exact match or same with trailing slash
        if (this.excludeUrls.has(key)) return true;
        if (this.excludeUrls.has(key.endsWith('/') ? key.slice(0, -1) : key + '/')) return true;

        return false;
    }


    // --- NEW: Sitemap loader (minimal changes, no external deps) ---
    async loadSitemapUrls() {
        const candidates = [
            `${this.baseUrl.replace(/\/+$/,'')}/sitemap.xml`,
            `${this.baseUrl.replace(/\/+$/,'')}/sitemap_index.xml`
        ];
        const discovered = new Set();

        const fetchXml = async (url) => {
            try {
                const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
                let buf = Buffer.from(res.data);
                const ct = (res.headers['content-type'] || '').toLowerCase();
                const ce = (res.headers['content-encoding'] || '').toLowerCase();
                if (url.endsWith('.gz') || ce.includes('gzip')) {
                    try { buf = zlib.gunzipSync(buf); } catch {}
                }
                return buf.toString('utf8');
            } catch {
                return null;
            }
        };

        const extractLocs = (xml) => {
            if (!xml) return [];
            const locs = [];
            const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
            let m;
            while ((m = re.exec(xml)) !== null) {
                locs.push(m[1].trim());
            }
            return locs;
        };

        const handleSitemap = async (url) => {
            const xml = await fetchXml(url);
            if (!xml) return;

            // If it's a sitemap index, recurse into child sitemaps
            if (/<sitemapindex[\s>]/i.test(xml)) {
                const locs = extractLocs(xml);
                for (const loc of locs) {
                    await handleSitemap(loc);
                }
                return;
            }

            // If it's a urlset, collect URLs
            if (/<urlset[\s>]/i.test(xml)) {
                const urls = extractLocs(xml);
                for (const u of urls) discovered.add(u);
                return;
            }

            // Fallback: try to parse any <loc> tags anyway
            const urls = extractLocs(xml);
            for (const u of urls) discovered.add(u);
        };

        for (const c of candidates) {
            await handleSitemap(c);
        }

        let enqueued = 0;

        for (const raw of discovered) {
            try {
                const fullUrl = new URL(raw, this.baseUrl).href;
                if (fullUrl.toLowerCase().endsWith('.pdf')) continue;
                if (this.isExcluded(fullUrl)) continue;
                const visitKey = this.normalizeForComparison(fullUrl);
                if (!visitKey) continue;
                if (this.isValidUrl(fullUrl) && !this.visited.has(visitKey)) {
                    this.toVisit.add({ url: fullUrl, depth: 0 });
                    enqueued++;
                }
            } catch {
                // ignore malformed entries
            }
        }

        console.log(`🧭 Sitemap: discovered ${discovered.size} URLs, enqueued ${enqueued} HTML pages, skipped direct PDF downloads`);
    }

    capturePageXHR(page, pageUrl, pageMeta = { title: '' }) {
        const ignorePatterns = ['translation.json', 'frontendlive', 'trigger-count', '/locales/', '/i18n'];
        const processedResponses = new Set();
        const cacheKey = this.normalizeForComparison(pageUrl) || pageUrl;
        this.pageXHRCache.set(cacheKey, []);
        const getPageXHRStore = () => {
            if (!this.pageXHRCache.has(cacheKey)) {
                this.pageXHRCache.set(cacheKey, []);
            }
            return this.pageXHRCache.get(cacheKey);
        };
        const addPdfFromItem = (item) => {
            if (!item || typeof item !== 'object') return;
            const candidateFields = ['link', 'url', 'file', 'document'];
            let pdfValue = null;
            for (const field of candidateFields) {
                const value = item[field];
                if (typeof value === 'string' && value.toLowerCase().includes('.pdf')) {
                    pdfValue = value;
                    break;
                }
                if (!pdfValue && value && typeof value === 'object') {
                    const nestedCandidate = typeof value.url === 'string' ? value.url : (typeof value.href === 'string' ? value.href : null);
                    if (nestedCandidate && nestedCandidate.toLowerCase().includes('.pdf')) {
                        pdfValue = nestedCandidate;
                        break;
                    }
                }
            }
            if (!pdfValue) return;

            let pdfUrl;
            try {
                pdfUrl = new URL(pdfValue, pageUrl).href;
            } catch {
                return;
            }
            const titleCandidates = [
                item.title,
                item.name,
                item.notification,
                item.subject,
                item.fileName,
                item.caption,
                item.heading
            ];
            const pdfTitle = (titleCandidates.find(v => typeof v === 'string' && v.trim().length > 0) || (pdfUrl.split('/').pop() || '')).trim();

            const textCandidates = [
                item.description,
                item.summary,
                item.details,
                item.note,
                item.content,
                item.notification,
                pdfTitle
            ];
            const textContent = (textCandidates.find(v => typeof v === 'string' && v.trim().length > 0) || '').trim();
            const wordCount = textContent ? textContent.split(/\s+/).filter(Boolean).length : 0;
            const parentTitle = (pageMeta && pageMeta.title) || '';
            const timestamp = new Date().toISOString();

            const pdfDoc = {
                url: pdfUrl,
                title: pdfTitle,
                text: textContent,
                pages: 0,
                category: this.categorizeUrl(pdfUrl, `${pdfTitle} ${textContent}`.trim()),
                timestamp,
                parentPageUrl: pageUrl,
                parentPageTitle: parentTitle,
                sourceUrl: pageUrl,
                sourceTitle: parentTitle,
                wordCount
            };

            const existingIndex = this.scrapedData.documents.pdfs.findIndex(doc => doc.url === pdfUrl);
            if (existingIndex !== -1) {
                const existing = this.scrapedData.documents.pdfs[existingIndex];
                this.scrapedData.documents.pdfs[existingIndex] = {
                    ...existing,
                    ...pdfDoc,
                    wordCount: pdfDoc.wordCount || existing.wordCount || 0,
                    pages: pdfDoc.pages || existing.pages || 0,
                    text: pdfDoc.text || existing.text || '',
                    category: pdfDoc.category || existing.category || 'general',
                    timestamp: pdfDoc.timestamp || existing.timestamp,
                    parentPageUrl: pdfDoc.parentPageUrl || existing.parentPageUrl,
                    parentPageTitle: pdfDoc.parentPageTitle || existing.parentPageTitle,
                    sourceUrl: pdfDoc.sourceUrl || existing.sourceUrl,
                    sourceTitle: pdfDoc.sourceTitle || existing.sourceTitle
                };
            } else {
                this.scrapedData.documents.pdfs.push(pdfDoc);
            }

            const linkEntry = {
                url: pdfUrl,
                text: pdfTitle || pdfUrl,
                title: pdfTitle || pdfUrl,
                sourceUrl: pageUrl,
                sourceTitle: parentTitle,
                context: textContent
            };
            if (!this.scrapedData.links.pdf.some(link => link.url === pdfUrl && link.sourceUrl === pageUrl)) {
                this.scrapedData.links.pdf.push(linkEntry);
            }

            this.pdfUrls.add(pdfUrl);
        };

        const processItems = (items) => {
            if (!Array.isArray(items) || !items.length || typeof items[0] !== 'object') return;
            items.forEach(addPdfFromItem);
        };

        const handler = async (response) => {
            try {
                const request = response.request();
                const resourceType = request.resourceType ? request.resourceType() : '';
                if (resourceType !== 'xhr' && resourceType !== 'fetch') return;

                const resUrl = response.url();
                const lowerUrl = resUrl.toLowerCase();
                if (ignorePatterns.some(pattern => lowerUrl.includes(pattern))) return;
                if (processedResponses.has(resUrl)) return;
                processedResponses.add(resUrl);

                if (typeof response.ok === 'function' && !response.ok()) return;
                const headers = (typeof response.headers === 'function' ? response.headers() : {}) || {};
                const contentType = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
                if (contentType && !contentType.includes('json')) return;

                let jsonData;
                try {
                    jsonData = await response.json();
                } catch {
                    return;
                }

                if (!jsonData || (typeof jsonData !== 'object' && !Array.isArray(jsonData))) {
                    return;
                }

                getPageXHRStore().push({
                    url: request.url(),
                    status: response.status(),
                    timestamp: new Date().toISOString(),
                    data: jsonData
                });

                if (Array.isArray(jsonData)) {
                    processItems(jsonData);
                    return;
                }

                if (jsonData && typeof jsonData === 'object') {
                    const candidateKeys = ['data', 'results', 'items', 'records', 'list'];
                    for (const key of candidateKeys) {
                        if (Array.isArray(jsonData[key])) {
                            processItems(jsonData[key]);
                        }
                    }
                }
            } catch {
                // Ignore individual response errors
            }
        };

        page.on('response', handler);
        return () => page.off('response', handler);
    }

    // --- END: Sitemap loader --- 
    async scrapePage(url, depth = 0) {
        if (this.isExcluded(url)) {
            return null;
        }
        const visitKey = this.normalizeForComparison(url) || url;
        if (this.visited.has(visitKey) || depth > this.maxDepth || this.visited.size >= this.maxPages) {
            return null;
        }

        console.log(`🔍 Scraping [${depth}/${this.maxDepth}] (${this.visited.size}/${this.maxPages}): ${url}`);
        this.visited.add(visitKey);

        const pageMeta = { title: '' };
        let detachXHR = this.capturePageXHR(this.page, url, pageMeta);
        let latestResolvedKey = null;

        try {
            await this.page.goto(url, { 
                waitUntil: 'networkidle0', 
                timeout: 45000 
            });

            // Wait for dynamic content to load
            await this.page.waitForTimeout(this.delay);

            pageMeta.title = (await this.page.title().catch(() => '')) || '';

            const extractFullDom = async () => {
                return await this.page.evaluate(() => {
                    const isHomePage = !window.location || window.location.pathname === '/' || window.location.pathname === '';
                    if (!isHomePage) {
                        const removeElements = (selectors = []) => {
                            selectors.forEach(selector => {
                                document.querySelectorAll(selector).forEach(node => node.remove());
                            });
                        };
                        removeElements(['footer', '#footer', '.footer', '.site-footer', '.bottom-footer']);
                        removeElements(['#site_accessibility_icon', '#site_accessibility', '.__access-main-css']);
                        removeElements(['[id*="accessibility"]', '[class*="accessibility"]']);
                    }

                    const data = {
                        title: document.title || '',
                        headings: [],
                        content: [],
                        links: [],
                        metadata: {
                            description: '',
                            keywords: ''
                        },
                        tables: [],
                        lists: []
                    };

                    const metaDescription = document.querySelector('meta[name="description"]');
                    if (metaDescription) {
                        data.metadata.description = metaDescription.getAttribute('content') || '';
                    }

                    const metaKeywords = document.querySelector('meta[name="keywords"]');
                    if (metaKeywords) {
                        data.metadata.keywords = metaKeywords.getAttribute('content') || '';
                    }

                    document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
                        data.headings.push({
                            level: parseInt(heading.tagName.charAt(1)),
                            text: heading.textContent.trim(),
                            id: heading.id || null
                        });
                    });

                    const contentSelectors = [
                        'p', 'div.content', '.main-content', '.page-content', '.article-content',
                        '.description', '.info', '.details', '.summary',
                        'article', 'section', '.text-content'
                    ];

                    contentSelectors.forEach(selector => {
                        document.querySelectorAll(selector).forEach(element => {
                            const text = element.textContent.trim();
                            if (text && text.length > 30 && !data.content.some(existing => existing.includes(text.substring(0, 50)))) {
                                data.content.push(text);
                            }
                        });
                    });

                    document.querySelectorAll('table').forEach(table => {
                        const tableData = [];
                        table.querySelectorAll('tr').forEach(row => {
                            const rowData = [];
                            row.querySelectorAll('td, th').forEach(cell => {
                                rowData.push(cell.textContent.trim());
                            });
                            if (rowData.length > 0) tableData.push(rowData);
                        });
                        if (tableData.length > 0) data.tables.push(tableData);
                    });

                    document.querySelectorAll('ul, ol').forEach(list => {
                        const listItems = [];
                        list.querySelectorAll('li').forEach(item => {
                            const text = item.textContent.trim();
                            if (text && text.length > 10) listItems.push(text);
                        });
                        if (listItems.length > 0) data.lists.push(listItems);
                    });

                    document.querySelectorAll('a[href]').forEach(link => {
                        const href = link.getAttribute('href');
                        const text = link.textContent.trim();
                        if (href) {
                            data.links.push({
                                href: href,
                                text: text || href,
                                title: link.getAttribute('title') || '',
                                className: link.className || '',
                                parentText: link.parentElement ? link.parentElement.textContent.trim().substring(0, 100) : ''
                            });
                        }
                    });

                    return data;
                });
            };

            const domSnapshots = [];
            try {
                const initialSnapshot = await extractFullDom();
                if (initialSnapshot) {
                    domSnapshots.push({ index: 0, data: initialSnapshot });
                }
            } catch {
                // ignore initial extraction failure
            }

            // inside scrapePage, after you define extractFullDom()
            let snapshotCounter = 1; // assuming you already pushed index 0

            const expandClientPagination = async () => {
                const maxIterations = 30;

                for (let i = 0; i < maxIterations; i++) {
                    // 1) take a small signature of current DOM so we can detect change
                    const prevSignature = await this.page.evaluate(() => {
                        const root =
                            document.querySelector('main') ||
                            document.querySelector('#root') ||
                            document.body;
                        const text = root ? root.innerText.slice(0, 500) : document.body.innerText.slice(0, 500);
                        return text;
                    });

                    // 2) try to click the "right arrow" next to the page number
                    const clicked = await this.page.evaluate(() => {
                        // find something that is *just* a number, like "1" or "2"
                        const numberEl = Array.from(document.querySelectorAll('*')).find(el => {
                            const t = (el.textContent || '').trim();
                            // single number, not empty, and parent has buttons
                            return /^\d+$/.test(t) &&
                                el.parentElement &&
                                el.parentElement.querySelectorAll('button').length >= 1;
                        });

                        if (numberEl) {
                            const parent = numberEl.parentElement;
                            const buttons = Array.from(parent.querySelectorAll('button'));

                            // usually this widget has either:
                            // page "1" + right arrow
                            // or left arrow + "2" + right arrow
                            // so the right arrow is the LAST button
                            const rightBtn = buttons[buttons.length - 1];

                            if (rightBtn &&
                                !rightBtn.disabled &&
                                rightBtn.getAttribute('aria-disabled') !== 'true') {
                                rightBtn.click();
                                return true;
                            }
                        }

                        // fallback: try common "next" selectors
                        const altNext =
                            document.querySelector('button[aria-label="Go to next page"]:not([disabled])') ||
                            document.querySelector('button[title="Next page"]:not([disabled])');
                        if (altNext) {
                            altNext.click();
                            return true;
                        }

                        return false;
                    }).catch(() => false);

                    if (!clicked) {
                        // no more pages
                        break;
                    }

                    // 3) wait for DOM to actually change
                    try {
                        await this.page.waitForFunction((oldSig) => {
                            const root =
                                document.querySelector('main') ||
                                document.querySelector('#root') ||
                                document.body;
                            const text = root ? root.innerText.slice(0, 500) : document.body.innerText.slice(0, 500);
                            return text !== oldSig;
                        }, { timeout: 3000 }, prevSignature);
                    } catch (e) {
                        // even if we didn't detect change, give it a bit
                        await this.page.waitForTimeout(600);
                    }

                    // 4) now grab this NEW state of the DOM
                    try {
                        const snapshot = await extractFullDom();
                        if (snapshot) {
                            domSnapshots.push({ index: snapshotCounter, data: snapshot });
                            snapshotCounter += 1;
                        }
                    } catch (e) {
                        // ignore and continue
                    }
                }
            };

            try {
                await expandClientPagination();
            } catch {
                // Ignore pagination expansion failures
            }

            // Try to load more content by scrolling
            await this.page.evaluate(() => {
                return new Promise((resolve) => {
                    let totalHeight = 0;
                    const distance = 100;
                    const timer = setInterval(() => {
                        const scrollHeight = document.body.scrollHeight;
                        window.scrollBy(0, distance);
                        totalHeight += distance;

                        if(totalHeight >= scrollHeight){
                            clearInterval(timer);
                            resolve();
                        }
                    }, 100);
                });
            });

            try {
                const postScrollSnapshot = await extractFullDom();
                if (postScrollSnapshot) {
                    domSnapshots.push({ index: snapshotCounter, data: postScrollSnapshot });
                    snapshotCounter += 1;
                }
            } catch {
                // ignore snapshot capture failure
            }

            const mergeDomSnapshots = (snapshots = []) => {
                const createEmpty = () => ({
                    title: '',
                    headings: [],
                    content: [],
                    links: [],
                    metadata: {
                        description: '',
                        keywords: ''
                    },
                    tables: [],
                    lists: []
                });

                if (!Array.isArray(snapshots) || snapshots.length === 0) {
                    return createEmpty();
                }

                const combined = createEmpty();
                const headingSet = new Set();
                const contentSet = new Set();
                const listSet = new Set();
                const linkSet = new Set();

                snapshots.forEach((snapshot) => {
                    const data = snapshot?.data;
                    if (!data || typeof data !== 'object') return;

                    if (!combined.title && data.title) {
                        combined.title = data.title;
                    }

                    if (data.metadata) {
                        if (!combined.metadata.description && data.metadata.description) {
                            combined.metadata.description = data.metadata.description;
                        }
                        if (!combined.metadata.keywords && data.metadata.keywords) {
                            combined.metadata.keywords = data.metadata.keywords;
                        }
                    }

                    if (Array.isArray(data.headings)) {
                        data.headings.forEach(heading => {
                            if (!heading || typeof heading !== 'object') return;
                            const key = `${heading.level || 0}|${heading.text || ''}|${heading.id || ''}`;
                            if (headingSet.has(key)) return;
                            headingSet.add(key);
                            combined.headings.push({
                                level: heading.level,
                                text: heading.text,
                                id: heading.id || null
                            });
                        });
                    }

                    if (Array.isArray(data.content)) {
                        data.content.forEach(text => {
                            if (!text || typeof text !== 'string') return;
                            if (contentSet.has(text)) return;
                            contentSet.add(text);
                            combined.content.push(text);
                        });
                    }

                    if (Array.isArray(data.tables)) {
                        data.tables.forEach(table => {
                            if (Array.isArray(table)) {
                                combined.tables.push(table.map(row => Array.isArray(row) ? [...row] : row));
                            } else if (table && typeof table === 'object') {
                                combined.tables.push({
                                    headers: Array.isArray(table.headers) ? [...table.headers] : [],
                                    rows: Array.isArray(table.rows) ? table.rows.map(row => Array.isArray(row) ? [...row] : row) : []
                                });
                            }
                        });
                    }

                    if (Array.isArray(data.lists)) {
                        data.lists.forEach(list => {
                            if (!Array.isArray(list)) return;
                            const key = list.join('||');
                            if (listSet.has(key)) return;
                            listSet.add(key);
                            combined.lists.push([...list]);
                        });
                    }

                    if (Array.isArray(data.links)) {
                        data.links.forEach(link => {
                            if (!link || typeof link !== 'object') return;
                            const href = link.href || link.url || '';
                            const key = `${href}|${link.text || ''}|${link.title || ''}`;
                            if (linkSet.has(key)) return;
                            linkSet.add(key);
                            combined.links.push({
                                href,
                                text: link.text || href,
                                title: link.title || '',
                                className: link.className || '',
                                parentText: link.parentText || ''
                            });
                        });
                    }
                });

                return combined;
            };

            const pageData = mergeDomSnapshots(domSnapshots);

            pageMeta.title = pageData.title || pageMeta.title;
            const finalPageTitle = pageMeta.title;
            if (finalPageTitle) {
                this.scrapedData.links.pdf.forEach(link => {
                    if (link.sourceUrl === url) {
                        link.sourceTitle = finalPageTitle;
                    }
                });
                this.scrapedData.documents.pdfs.forEach(pdf => {
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
            const tableTextContent = (() => {
                if (!Array.isArray(extractedTables)) return [];
                const lines = [];
                extractedTables.forEach(table => {
                    if (!table) return;
                    if (Array.isArray(table)) {
                        table.forEach(row => {
                            if (Array.isArray(row)) {
                                lines.push(row.join(' '));
                            } else if (row) {
                                lines.push(String(row));
                            }
                        });
                        return;
                    }
                    if (typeof table === 'object') {
                        if (Array.isArray(table.headers) && table.headers.length) {
                            lines.push(table.headers.join(' '));
                        }
                        if (Array.isArray(table.rows)) {
                            table.rows.forEach(row => {
                                if (Array.isArray(row)) {
                                    lines.push(row.join(' '));
                                } else if (row) {
                                    lines.push(String(row));
                                }
                            });
                        }
                    }
                });
                return lines;
            })();

            const cleanedLinks = [];
            const seenLinks = new Set();
            pageData.links.forEach(link => {
                const rawHref = (link.href || '').trim();
                if (!rawHref) return;
                const lowerHref = rawHref.toLowerCase();
                if (lowerHref.startsWith('javascript:') || lowerHref.startsWith('mailto:') || lowerHref.startsWith('tel:')) return;
                if (rawHref === '#') return;

                let absoluteHref;
                try {
                    absoluteHref = new URL(rawHref, url).href;
                } catch {
                    return;
                }

                if (!seenLinks.has(absoluteHref)) {
                    seenLinks.add(absoluteHref);
                    cleanedLinks.push({
                        ...link,
                        href: absoluteHref
                    });
                }
            });
            pageData.links = cleanedLinks;

            const allContent = [
                pageData.title,
                ...pageData.headings.map(h => h.text),
                ...pageData.content,
                ...tableTextContent,
                ...pageData.lists.flat(),
                pageData.metadata.description,
                pageData.metadata.keywords
            ].filter(Boolean).join(' ');

            const cacheKey = this.normalizeForComparison(url) || url;
            const resolvedUrl = this.page.url();
            const resolvedKey = this.normalizeForComparison(resolvedUrl) || resolvedUrl;
            latestResolvedKey = resolvedKey;
            const xhrEntries = [];
            const seenXhr = new Set();
            const collectXhrFromKey = (key) => {
                if (!key) return;
                const bucket = this.pageXHRCache.get(key);
                if (!bucket || !Array.isArray(bucket)) return;
                bucket.forEach(entry => {
                    if (!entry || typeof entry !== 'object') return;
                    const signature = `${entry.url || ''}|${entry.timestamp || ''}`;
                    if (seenXhr.has(signature)) return;
                    seenXhr.add(signature);
                    xhrEntries.push(entry);
                });
            };
            collectXhrFromKey(cacheKey);
            if (resolvedKey && resolvedKey !== cacheKey) {
                collectXhrFromKey(resolvedKey);
            }
            this.pageXHRCache.set(cacheKey, xhrEntries);
            if (resolvedKey && resolvedKey !== cacheKey) {
                this.pageXHRCache.set(resolvedKey, xhrEntries);
            }

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
                links: pageData.links,
                metadata: pageData.metadata,
                xhrResponses: xhrEntries,
                domSnapshots: domSnapshots,
                category: this.categorizeUrl(url, allContent),
                wordCount: allContent.split(' ').length
            };

            this.scrapedData.pages.push(processedPage);
            console.log(`Page ${processedPage.url} -> ${processedPage.xhrResponses.length} XHR responses captured`);

            pageData.links.forEach(link => {
                try {
                    const fullUrl = link.href;
                    const hrefLower = fullUrl.toLowerCase();
                    const linkData = {
                        url: fullUrl,
                        text: link.text,
                        title: link.title,
                        sourceUrl: url,
                        sourceTitle: currentSourceTitle,
                        context: link.parentText
                    };

                    if (hrefLower.includes('.pdf')) {
                        if (!this.scrapedData.links.pdf.some(existing => existing.url === fullUrl && existing.sourceUrl === url)) {
                            this.scrapedData.links.pdf.push(linkData);
                        }
                        this.pdfUrls.add(fullUrl);
                    } else if (hrefLower.match(/\.(jpg|jpeg|png|gif|webp)$/)) {
                        this.scrapedData.links.image.push(linkData);
                    } else if (fullUrl.includes('nitjsr.ac.in')) {
                        this.scrapedData.links.internal.push(linkData);
                        const childVisitKey = this.normalizeForComparison(fullUrl);
                        if (childVisitKey && this.isValidUrl(fullUrl) && !this.visited.has(childVisitKey) && !this.isExcluded(fullUrl)) {
                            this.toVisit.add({url: fullUrl, depth: depth + 1});
                        }
                    } else {
                        this.scrapedData.links.external.push(linkData);
                    }
                } catch {
                    // Invalid URL, skip
                }
            });

            console.log(`✅ Scraped: ${pageData.title} (${allContent.split(' ').length} words, ${pageData.links.length} links)`);
            return processedPage;

        } catch (error) {
            console.error(`❌ Failed to scrape ${url}:`, error.message);
            return null;
        } finally {
            if (detachXHR) {
                detachXHR();
            }
            const cleanupKey = this.normalizeForComparison(url) || url;
            if (cleanupKey) {
                this.pageXHRCache.delete(cleanupKey);
            }
            if (latestResolvedKey && latestResolvedKey !== cleanupKey) {
                this.pageXHRCache.delete(latestResolvedKey);
            }
        }
    }

    async processPDFDocuments() {
        console.log(`dY", Processing ${this.pdfUrls.size} discovered PDF documents...`);
        
        const pdfArray = Array.from(this.pdfUrls);
        const maxPdfs = Math.min(pdfArray.length, 50); // Increased PDF limit

        for (let i = 0; i < maxPdfs; i++) {
            const pdfUrl = pdfArray[i];
            try {
                console.log(`dY"- Processing PDF ${i + 1}/${maxPdfs}: ${pdfUrl}`);

                let pdfText = '';
                let pdfPages = 0;

                try {
                    const response = await axios.get(pdfUrl, { 
                        responseType: 'arraybuffer',
                        timeout: 60000, // Increased timeout
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        },
                        maxContentLength: 50 * 1024 * 1024 // 50MB limit
                    });

                    try {
                        const pdfData = await pdfParse(response.data);
                        pdfText = pdfData.text || '';
                        pdfPages = pdfData.numpages || 0;
                    } catch (parseError) {
                        console.error(`??O Failed to parse PDF ${pdfUrl}:`, parseError.message);
                    }
                } catch (downloadError) {
                    console.error(`??O Failed to download PDF ${pdfUrl}:`, downloadError.message);
                }
                
                // Find the link information for this PDF
                const linkInfo = this.scrapedData.links.pdf.find(link => link.url === pdfUrl);
                
                const pdfDoc = {
                    url: pdfUrl,
                    title: linkInfo ? linkInfo.text : pdfUrl.split('/').pop(),
                    text: pdfText,
                    pages: pdfPages,
                    category: this.categorizeUrl(pdfUrl, pdfText),
                    timestamp: new Date().toISOString(),
                    parentPageUrl: linkInfo ? linkInfo.sourceUrl : '',
                    parentPageTitle: linkInfo ? linkInfo.sourceTitle : '',
                    sourceUrl: linkInfo ? linkInfo.sourceUrl : '',
                    sourceTitle: linkInfo ? linkInfo.sourceTitle : '',
                    wordCount: pdfText ? pdfText.split(' ').length : 0
                };

                const existingIndex = this.scrapedData.documents.pdfs.findIndex(doc => doc.url === pdfUrl);
                if (existingIndex !== -1) {
                    const existing = this.scrapedData.documents.pdfs[existingIndex];
                    this.scrapedData.documents.pdfs[existingIndex] = {
                        ...existing,
                        ...pdfDoc,
                        wordCount: pdfDoc.wordCount || existing.wordCount || 0,
                        pages: pdfDoc.pages || existing.pages || 0,
                        text: pdfDoc.text || existing.text || '',
                        category: pdfDoc.category || existing.category || 'general',
                        timestamp: pdfDoc.timestamp || existing.timestamp,
                        parentPageUrl: pdfDoc.parentPageUrl || existing.parentPageUrl,
                        parentPageTitle: pdfDoc.parentPageTitle || existing.parentPageTitle,
                        sourceUrl: pdfDoc.sourceUrl || existing.sourceUrl,
                        sourceTitle: pdfDoc.sourceTitle || existing.sourceTitle
                    };
                } else {
                    this.scrapedData.documents.pdfs.push(pdfDoc);
                }
                console.log(`?o. Processed PDF: ${pdfDoc.pages} pages, ${pdfDoc.wordCount} words`);

            } catch (error) {
                console.error(`??O Failed to process PDF ${pdfUrl}:`, error.message);
            }
        }
    }

    async scrapeComprehensive() {
        try {
            await this.initialize();
            this.priorityQueue = [];

            const prioritySeen = new Set();
            this.priorityUrls.forEach(priorityUrl => {
                try {
                    const fullUrl = this.normalizeUrl(priorityUrl);
                    if (!fullUrl) return;
                    if (this.isExcluded(fullUrl)) return;
                    if (!this.isValidUrl(fullUrl)) return;
                    const priorityKey = this.normalizeForComparison(fullUrl) || fullUrl;
                    if (prioritySeen.has(priorityKey) || this.visited.has(priorityKey)) return;
                    prioritySeen.add(priorityKey);
                    const entry = { url: fullUrl, depth: 0 };
                    this.priorityQueue.push(entry);
                    this.toVisit.add(entry);
                } catch {
                    // ignore invalid priority URL
                }
            });
            
            const startUrls = [
                'https://nitjsr.ac.in/',
            ];

            // Add starting URLs to visit queue
            startUrls.forEach(url => {
                const normalized = this.normalizeUrl(url);
                if (!normalized) return;
                if (this.isExcluded(normalized)) return;
                const startKey = this.normalizeForComparison(normalized);
                if (startKey && this.visited.has(startKey)) return;
                this.toVisit.add({url: normalized, depth: 0});
            });

            // --- NEW: seed queue from sitemap(s) ---
            await this.loadSitemapUrls();
            // --- END NEW ---

            console.log(`🌐 Starting enhanced comprehensive scrape of ${startUrls.length} main sections...`);

            while ((this.priorityQueue.length > 0 || this.toVisit.size > 0) && this.visited.size < this.maxPages) {
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
                    console.log(`📊 Progress: ${this.visited.size}/${this.maxPages} pages scraped, ${this.pdfUrls.size} PDFs found`);
                }
            }

            await this.processPDFDocuments();

            this.updateStatistics();

            const result = await this.saveData();
            await this.cleanup();

            return result;

        } catch (error) {
            console.error('❌ Enhanced comprehensive scraping failed:', error.message);
            await this.cleanup();
            throw error;
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
    }

    async saveData() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '_');
        const filename = `nitjsr_enhanced_comprehensive_${timestamp}.json`;
        const filepath = path.join(__dirname, 'scraped_data', filename);

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
                count
            })),
            pdfBreakdown: this.scrapedData.documents.pdfs.map(pdf => ({
                title: pdf.title,
                pages: pdf.pages,
                wordCount: pdf.wordCount,
                category: pdf.category
            })),
            filepath: filepath
        };

        console.log(`💾 Data saved to: ${filepath}`);
        console.log(`📊 Summary: ${summary.totalPages} pages, ${summary.totalPDFs} PDFs, ${summary.totalLinks} links`);

        return { summary, filepath, data: this.scrapedData };
    }

    async cleanup() {
        if (this.browser) {
            await this.browser.close();
            console.log('🧹 Browser cleanup completed');
        }
    }
}

export { NITJSRScraper };
