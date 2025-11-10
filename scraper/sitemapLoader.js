import axios from 'axios';
import zlib from 'zlib';

export class SitemapLoader {
    constructor(baseUrl, urlHelpers, pdfPolicy, categorizer) {
        this.baseUrl = baseUrl;
        this.urlHelpers = urlHelpers;
        this.pdfPolicy = pdfPolicy;
        this.categorizer = categorizer;
    }

    async loadSitemapUrls(visited, toVisit, isExcluded) {
        const candidates = [
            `${this.baseUrl.replace(/\/+$/, '')}/sitemap.xml`,
            `${this.baseUrl.replace(/\/+$/, '')}/sitemap_index.xml`,
        ];
        const discovered = new Set();

        const handleSitemap = async (url) => {
            const xml = await this.fetchXml(url);
            if (!xml) return;

            // If it's a sitemap index, recurse into child sitemaps
            if (/<sitemapindex[\s>]/i.test(xml)) {
                const locs = this.extractLocs(xml);
                for (const loc of locs) {
                    await handleSitemap(loc);
                }
                return;
            }

            // If it's a urlset, collect URLs with optional lastmod
            if (/<urlset[\s>]/i.test(xml)) {
                const entries = this.extractUrlEntries(xml);
                if (entries && entries.length) {
                    const cutoffTender = this.pdfPolicy.monthsAgo(6);
                    const cutoffNotices = this.pdfPolicy.monthsAgo(1);
                    for (const e of entries) {
                        try {
                            const fullUrl = new URL(e.loc, this.baseUrl).href;
                            const isPdf = fullUrl.toLowerCase().endsWith('.pdf');
                            if (!isPdf) {
                                discovered.add(fullUrl);
                                continue;
                            }

                            // Only enforce policy for backend tender/notices PDFs
                            const special = this.categorizer.specialPdfCategory(fullUrl);
                            if (special === 'tender' || special === 'notices') {
                                let ok = false;
                                if (e.lastmod) {
                                    const d = new Date(e.lastmod);
                                    if (!isNaN(d)) {
                                        if (
                                            (special === 'tender' && d >= cutoffTender) ||
                                            (special === 'notices' && d >= cutoffNotices)
                                        ) {
                                            ok = true;
                                            this.pdfPolicy.allowPdf(fullUrl, d.toISOString(), this.urlHelpers);
                                        }
                                    }
                                }
                                // If lastmod missing or invalid, do not allow by strict sitemap policy
                            } else {
                                // Other PDFs: no policy gating, but record date if present for enrichment
                                if (e.lastmod) {
                                    const d = new Date(e.lastmod);
                                    if (!isNaN(d)) {
                                        this.pdfPolicy.allowPdf(fullUrl, d.toISOString(), this.urlHelpers);
                                    }
                                }
                            }
                        } catch {
                            // ignore bad url entries
                        }
                    }
                    return;
                }

                // Fallback when there are only <loc> tags
                const urls = this.extractLocs(xml);
                for (const u of urls) discovered.add(u);
                return;
            }

            // Fallback: try to parse any <loc> tags anyway
            const urls = this.extractLocs(xml);
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
                if (isExcluded(fullUrl)) continue;
                const visitKey = this.urlHelpers.normalizeForComparison(fullUrl);
                if (!visitKey) continue;
                if (this.urlHelpers.isValidUrl(fullUrl) && !visited.has(visitKey)) {
                    toVisit.add({ url: fullUrl, depth: 0 });
                    enqueued++;
                }
            } catch {
                // ignore malformed entries
            }
        }

        console.log(
            `🧭 Sitemap: discovered ${discovered.size} URLs, enqueued ${enqueued} HTML pages, skipped direct PDF downloads`
        );
    }

    async fetchXml(url) {
        try {
            const res = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 30000,
            });
            let buf = Buffer.from(res.data);
            const ct = (res.headers['content-type'] || '').toLowerCase();
            const ce = (res.headers['content-encoding'] || '').toLowerCase();
            if (url.endsWith('.gz') || ce.includes('gzip')) {
                try {
                    buf = zlib.gunzipSync(buf);
                } catch {}
            }
            return buf.toString('utf8');
        } catch {
            return null;
        }
    }

    extractLocs(xml) {
        if (!xml) return [];
        const locs = [];
        const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
        let m;
        while ((m = re.exec(xml)) !== null) {
            locs.push(m[1].trim());
        }
        return locs;
    }

    extractUrlEntries(xml) {
        if (!xml) return [];
        const entries = [];
        const re = /<url>([\s\S]*?)<\/url>/gi;
        let m;
        while ((m = re.exec(xml)) !== null) {
            const block = m[1];
            const locMatch = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(block);
            if (!locMatch) continue;
            const lastmodMatch = /<lastmod>\s*([^<]+)\s*<\/lastmod>/i.exec(block);
            entries.push({
                loc: locMatch[1].trim(),
                lastmod: lastmodMatch ? lastmodMatch[1].trim() : null,
            });
        }
        return entries;
    }
}