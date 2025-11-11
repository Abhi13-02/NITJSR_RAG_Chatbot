export class UrlHelpers {
    constructor(baseUrl = 'https://nitjsr.ac.in') {
        this.baseUrl = baseUrl;
    }

    isValidUrl(url) {
        try {
            const urlObj = new URL(url, this.baseUrl);
            const normalizedHref = urlObj.href.toLowerCase();

            // Only scrape nitjsr.ac.in domain
            if (!urlObj.hostname.includes('nitjsr.ac.in')) {
                return false;
            }

            // Skip certain file types and external links
            const skipExtensions = [
                '.jpg',
                '.jpeg',
                '.png',
                '.gif',
                '.css',
                '.js',
                '.ico',
                '.svg',
                '.woff',
                '.woff2',
                '.ttf',
                '.map',
            ];
            const skipPatterns = [
                'mailto:',
                'tel:',
                'javascript:',
                '#',
                '/assets/',
                '/static/',
                '/locales/',
                '/images/',
                '/fonts/',
                'facebook.com',
                'twitter.com',
                'linkedin.com',
                'youtube.com',
                'google.com',
                'maps.google',
                'instagram.com',
            ];

            const pathname = urlObj.pathname.toLowerCase();
            const full = normalizedHref;

            if (skipExtensions.some((ext) => pathname.endsWith(ext))) return false;
            return !skipPatterns.some((pattern) => full.includes(pattern));


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


    normalizeInputList(input) {
        if (input === undefined || input === null) return [];
        if (Array.isArray(input)) {
            return input
                .map((value) =>
                    typeof value === 'string' ? value.trim() : String(value).trim()
                )
                .filter(Boolean);
        }
        if (typeof input === 'string') {
            return input
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean);
        }
        return [];
    }


    normalizeUrlCollection(input) {
        return this.normalizeInputList(input)
            .map((entry) => this.normalizeUrl(entry))
            .filter(Boolean);
    }

}