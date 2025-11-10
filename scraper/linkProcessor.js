export class LinkProcessor {

    constructor(
        scrapedData,
        pdfUrls,
        pdfUrlOriginals,
        urlHelpers,
        categorizer,
        pdfPolicy,
        toVisit,
        visited,
        isExcluded
    ) {
        this.scrapedData = scrapedData;
        this.pdfUrls = pdfUrls;
        this.pdfUrlOriginals = pdfUrlOriginals;
        this.urlHelpers = urlHelpers;
        this.categorizer = categorizer;
        this.pdfPolicy = pdfPolicy;
        this.toVisit = toVisit;
        this.visited = visited;
        this.isExcluded = isExcluded;
    }


    processLinks(links, pageUrl, depth, currentSourceTitle) {
        links.forEach((link) => {
            try {
                const fullUrl = link.href;
                const hrefLower = fullUrl.toLowerCase();
                const linkData = {
                    url: fullUrl,
                    text: link.text,
                    title: link.title,
                    sourceUrl: pageUrl,
                    sourceTitle: currentSourceTitle,
                    context: link.parentText,
                };

                if (hrefLower.includes('.pdf')) {
                    this.processPdfLink(fullUrl, linkData, pageUrl);
                } else if (hrefLower.match(/\.(jpg|jpeg|png|gif|webp)$/)) {
                    this.scrapedData.links.image.push(linkData);
                } else if (fullUrl.includes('nitjsr.ac.in')) {
                    this.processInternalLink(fullUrl, linkData, depth);
                } else {
                    this.scrapedData.links.external.push(linkData);
                }
            } catch {
                // Invalid URL, skip
            }
        });
    }


    processPdfLink(fullUrl, linkData, pageUrl) {
        // Apply same policy to DOM-found tender/notice PDFs
        const specialCat = this.categorizer.specialPdfCategory(fullUrl);
        if (specialCat === 'tender' || specialCat === 'notices') {
            const allowed = this.pdfPolicy.isPdfAllowedByPolicy(
                fullUrl,
                specialCat,
                this.urlHelpers,
                this.categorizer
            );
            if (!allowed) {
                // too old → skip
                return;
            }
        }

        if (
            !this.scrapedData.links.pdf.some(
                (existing) => existing.url === fullUrl && existing.sourceUrl === linkData.sourceUrl
            )
        ) {
            this.scrapedData.links.pdf.push(linkData);
        }

        const normalizedPdfUrl = fullUrl.split('#')[0].split('?')[0].toLowerCase();
        const before = this.pdfUrls.size;
        this.pdfUrls.add(normalizedPdfUrl);
        if (!this.pdfUrlOriginals.has(normalizedPdfUrl)) {
            this.pdfUrlOriginals.set(normalizedPdfUrl, fullUrl);
        }
        const after = this.pdfUrls.size;
        if (after > before) {
            console.log(
                `[pdf-added] ${normalizedPdfUrl}  (source: ${linkData.sourceUrl})  totalUniquePDFs=${after}`
            );
        }
    }


    processInternalLink(fullUrl, linkData, depth) {
        this.scrapedData.links.internal.push(linkData);
        const childVisitKey = this.urlHelpers.normalizeForComparison(fullUrl);
        if (
            childVisitKey &&
            this.urlHelpers.isValidUrl(fullUrl) &&
            !this.visited.has(childVisitKey) &&
            !this.isExcluded(fullUrl)
        ) {
            this.toVisit.add({ url: fullUrl, depth: depth + 1 });
        }
    }


    getLinkCounts(pageUrl) {
        const pdfCount = this.scrapedData.links.pdf
            ? this.scrapedData.links.pdf.filter((link) => link.sourceUrl === pageUrl).length
            : 0;
        const internalCount = this.scrapedData.links.internal
            ? this.scrapedData.links.internal.filter((link) => link.sourceUrl === pageUrl).length
            : 0;
        const externalCount = this.scrapedData.links.external
            ? this.scrapedData.links.external.filter((link) => link.sourceUrl === pageUrl).length
            : 0;

        return { pdfCount, internalCount, externalCount };
    }

}