export class XhrCapture {
    constructor(urlHelpers, categorizer, pdfPolicy, scrapedData, pdfUrls, pdfUrlOriginals) {
        this.urlHelpers = urlHelpers;
        this.categorizer = categorizer;
        this.pdfPolicy = pdfPolicy;
        this.scrapedData = scrapedData;
        this.pdfUrls = pdfUrls;
        this.pdfUrlOriginals = pdfUrlOriginals;
        this.pageXHRCache = new Map();
    }

    capturePageXHR(page, pageUrl, pageMeta = { title: '' }) {
        const ignorePatterns = [
            'translation.json',
            'frontendlive',
            'trigger-count',
            '/locales/',
            '/i18n',
        ];
        const processedResponses = new Set();
        const cacheKey = this.urlHelpers.normalizeForComparison(pageUrl) || pageUrl;
        this.pageXHRCache.set(cacheKey, []);

        const getPageXHRStore = () => {
            if (!this.pageXHRCache.has(cacheKey)) {
                this.pageXHRCache.set(cacheKey, []);
            }
            return this.pageXHRCache.get(cacheKey);
        };

        const addPdfFromItem = (item) => {
            if (!item || typeof item !== 'object') return;
            const candidateFields = ['link', 'url', 'file', 'document', 'path'];
            let pdfValue = null;

            for (const field of candidateFields) {
                const value = item[field];
                if (typeof value === 'string' && value.toLowerCase().includes('.pdf')) {
                    pdfValue = value;
                    break;
                }
                if (!pdfValue && value && typeof value === 'object') {
                    const nestedCandidate =
                        typeof value.url === 'string'
                            ? value.url
                            : typeof value.href === 'string'
                                ? value.href
                                : null;
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

            // Determine category and apply item-based date policy for tenders/notices
            const special = this.categorizer.specialPdfCategory(pdfUrl);
            let policyCat = special || null;

            try {
                if (!policyCat && Array.isArray(item.notification_for)) {
                    const tags = item.notification_for.map(String).map((s) => s.toLowerCase());
                    if (
                        tags.includes('announcement') ||
                        tags.includes('notice') ||
                        tags.includes('notifications') ||
                        tags.includes('recruitments')
                    ) {
                        policyCat = 'notices';
                    }
                }
            } catch {}

            const preCat =
                policyCat ||
                this.categorizer.categorizeUrl(
                    pdfUrl,
                    `${item?.title || ''} ${item?.notification || ''}`.trim()
                );

            const itemDate = this.getDateFromItem(item);
            if (
                (preCat === 'tender' || preCat === 'notices' || preCat === 'recruitments') &&
                itemDate
            ) {
                const months = this.pdfPolicy.getCategoryMaxAgeMonths(preCat);
                if (months) {
                    const cutoff = this.pdfPolicy.monthsAgo(months);
                    if (itemDate < cutoff) {
                        // Skip old tender/notice per item-provided date
                        return;
                    }
                }
            }

            const titleCandidates = [
                item.title,
                item.name,
                item.notification,
                item.subject,
                item.fileName,
                item.caption,
                item.heading,
            ];
            const pdfTitle = (
                titleCandidates.find((v) => typeof v === 'string' && v.trim().length > 0) ||
                pdfUrl.split('/').pop() ||
                ''
            ).trim();

            const textCandidates = [
                item.description,
                item.summary,
                item.details,
                item.note,
                item.content,
                item.notification,
                pdfTitle,
            ];
            const textContent = (
                textCandidates.find((v) => typeof v === 'string' && v.trim().length > 0) || ''
            ).trim();
            const wordCount = textContent ? textContent.split(/\s+/).filter(Boolean).length : 0;
            const parentTitle = (pageMeta && pageMeta.title) || '';
            const timestamp = new Date().toISOString();

            const pdfDoc = {
                url: pdfUrl,
                title: pdfTitle,
                text: textContent,
                pages: 0,
                category: preCat,
                timestamp,
                parentPageUrl: pageUrl,
                parentPageTitle: parentTitle,
                sourceUrl: pageUrl,
                sourceTitle: parentTitle,
                wordCount,
            };

            // Attach publishedAt from item when available
            if (itemDate && !isNaN(itemDate)) {
                pdfDoc.publishedAt = itemDate.toISOString();
                pdfDoc.publishedAtSource = 'item';
            } else {
                // fallback to sitemap date if we have one
                try {
                    const iso = this.pdfPolicy.getPdfDate(pdfUrl, this.urlHelpers);
                    if (iso) {
                        pdfDoc.publishedAt = iso;
                        pdfDoc.publishedAtSource = 'sitemap';
                    }
                } catch {}
            }

            const existingIndex = this.scrapedData.documents.pdfs.findIndex((doc) => doc.url === pdfUrl);
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
                    sourceTitle: pdfDoc.sourceTitle || existing.sourceTitle,
                    publishedAt: pdfDoc.publishedAt || existing.publishedAt || null,
                    publishedAtSource: pdfDoc.publishedAtSource || existing.publishedAtSource || null,
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
                context: textContent,
            };
            if (
                !this.scrapedData.links.pdf.some(
                    (link) => link.url === pdfUrl && link.sourceUrl === pageUrl
                )
            ) {
                this.scrapedData.links.pdf.push(linkEntry);
            }

            const normalizedPdfUrl = pdfUrl.split('#')[0].split('?')[0].toLowerCase();
            const before = this.pdfUrls.size;
            this.pdfUrls.add(normalizedPdfUrl);
            if (!this.pdfUrlOriginals.has(normalizedPdfUrl)) {
                this.pdfUrlOriginals.set(normalizedPdfUrl, pdfUrl);
            }
            const after = this.pdfUrls.size;
            if (after > before) {
                console.log(
                    `[pdf-added] ${normalizedPdfUrl}  (source: ${pageUrl})  totalUniquePDFs=${after}`
                );
            }
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
                if (ignorePatterns.some((pattern) => lowerUrl.includes(pattern))) return;
                if (processedResponses.has(resUrl)) return;
                processedResponses.add(resUrl);

                if (typeof response.ok === 'function' && !response.ok()) return;
                const headers =
                    (typeof response.headers === 'function' ? response.headers() : {}) || {};
                const contentType = (
                    headers['content-type'] ||
                    headers['Content-Type'] ||
                    ''
                ).toLowerCase();
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
                    data: jsonData,
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

    getDateFromItem(obj) {
        if (!obj || typeof obj !== 'object') return null;
        const keys = [
            'time',
            'date',
            'idate',
            'published_on',
            'created_at',
            'updated_at',
            'end_time',
        ];
        for (const k of keys) {
            const v = obj[k];
            if (v == null) continue;
            if (typeof v === 'number') {
                const ms = v > 1e12 ? v : v * 1000;
                const d = new Date(ms);
                if (!isNaN(d)) return d;
                continue;
            }
            if (typeof v === 'string') {
                const t = v.trim();
                if (!t) continue;
                if (/^\d{10,}$/.test(t)) {
                    const n = parseInt(t, 10);
                    const ms = n > 1e12 ? n : n * 1000;
                    const d = new Date(ms);
                    if (!isNaN(d)) return d;
                }
                const d = new Date(t);
                if (!isNaN(d)) return d;
            }
        }
        return null;
    }

    getXhrForPage(url) {
        const key = this.urlHelpers.normalizeForComparison(url) || url;
        return this.pageXHRCache.get(key) || [];
    }

    clearXhrForPage(url) {
        const key = this.urlHelpers.normalizeForComparison(url) || url;
        this.pageXHRCache.delete(key);
    }

    mergeXhrEntries(originalKey, resolvedKey) {
        const xhrEntries = [];
        const seenXhr = new Set();

        const collectXhrFromKey = (key) => {
            if (!key) return;
            const bucket = this.pageXHRCache.get(key);
            if (!bucket || !Array.isArray(bucket)) return;
            bucket.forEach((entry) => {
                if (!entry || typeof entry !== 'object') return;
                const signature = `${entry.url || ''}|${entry.timestamp || ''}`;
                if (seenXhr.has(signature)) return;
                seenXhr.add(signature);
                xhrEntries.push(entry);
            });
        };

        collectXhrFromKey(originalKey);
        if (resolvedKey && resolvedKey !== originalKey) {
            collectXhrFromKey(resolvedKey);
        }

        this.pageXHRCache.set(originalKey, xhrEntries);
        if (resolvedKey && resolvedKey !== originalKey) {
            this.pageXHRCache.set(resolvedKey, xhrEntries);
        }

        return xhrEntries;
    }
}