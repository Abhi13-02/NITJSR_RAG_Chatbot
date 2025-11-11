export class PdfPolicy {
    constructor() {
        this.sitemapPdfPolicy = {
            allow: new Set(),
            dates: new Map(),
        };
    }

    monthsAgo(months = 0) {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setMonth(d.getMonth() - Number(months || 0));
        return d;
    }

    getCategoryMaxAgeMonths(category = '') {
        const c = String(category || '').toLowerCase();
        if (c === 'tender') return 6;
        if (
            c === 'notices' ||
            c === 'notice' ||
            c === 'notification' ||
            c === 'notifications' ||
            c === 'recruitments'
        )
            return 1;
        return null; // no limit for other categories
    }

    normalizePolicyKey(url, urlHelpers) {
        const n = urlHelpers.normalizeForComparison(url);
        return n || (typeof url === 'string' ? url.trim().toLowerCase() : null);
    }

    isPdfAllowedByPolicy(url, category, urlHelpers, categorizer) {
        const cat = (category || categorizer.specialPdfCategory(url) || '').toLowerCase();
        if (cat === 'tender' || cat === 'notices') {
            const key = this.normalizePolicyKey(url, urlHelpers);
            return !!(key && this.sitemapPdfPolicy.allow.has(key));
        }
        return true; // other categories unfiltered
    }

    allowPdf(url, date, urlHelpers) {
        const key = this.normalizePolicyKey(url, urlHelpers);
        if (key) {
            this.sitemapPdfPolicy.allow.add(key);
            this.sitemapPdfPolicy.dates.set(key, date);
        }
    }

    getPdfDate(url, urlHelpers) {
        const key = this.normalizePolicyKey(url, urlHelpers);
        return key ? this.sitemapPdfPolicy.dates.get(key) : null;
    }
}