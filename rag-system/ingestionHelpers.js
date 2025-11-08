import {
    countWords,
    extractTextFromXhrResponses,
    flattenTablesToText,
} from './ragUtils.js';

export function buildPageLinkStats(scrapedData = {}) {
    const stats = new Map();
    const linkBuckets = scrapedData?.links || {};

    const getOrCreateEntry = (sourceUrl) => {
        if (!sourceUrl) {
            return null;
        }
        if (!stats.has(sourceUrl)) {
            stats.set(sourceUrl, {
                total: 0,
                pdf: 0,
                internal: 0,
                external: 0,
                image: 0
            });
        }
        return stats.get(sourceUrl);
    };

    const accumulate = (links = [], type) => {
        if (!Array.isArray(links)) {
            return;
        }
        links.forEach(link => {
            const entry = getOrCreateEntry(link?.sourceUrl);
            if (!entry) {
                return;
            }
            entry.total += 1;
            if (typeof entry[type] === 'number') {
                entry[type] += 1;
            } else {
                entry[type] = 1;
            }
        });
    };

    accumulate(linkBuckets.pdf, 'pdf');
    accumulate(linkBuckets.internal, 'internal');
    accumulate(linkBuckets.external, 'external');
    accumulate(linkBuckets.image, 'image');

    return stats;
}

export function prepareIngestionItems(scrapedData = {}) {
    const items = [];
    const pageLinkStats = buildPageLinkStats(scrapedData);
    const pages = scrapedData.pages || [];
    for (const page of pages) {
        const xhrText = extractTextFromXhrResponses(page?.xhrResponses || []);
        const structuredParts = [
            `Title: ${page.title || ''}`,
            `URL: ${page.url}`,
            `Category: ${page.category || 'general'}`,
            page.headings?.map(h => `Heading ${h.level}: ${h.text}`).join('\n') || '',
            page.content || '',
            flattenTablesToText(page.tables) || '',
            page.lists?.map(list => list.map(item => `- ${item}`).join('\n')).join('\n\n') || '',
            `Description: ${page.metadata?.description || ''}`,
            `Keywords: ${page.metadata?.keywords || ''}`
        ];

        if (xhrText) {
            structuredParts.push(`XHR API Insights:\n${xhrText}`);
        }

        const structuredText = structuredParts.filter(Boolean).join('\n\n');

        if (!structuredText || structuredText.trim().length <= 100) {
            continue;
        }
        const hasXhr = Boolean(xhrText);
        const combinedWordCount = countWords(structuredText);

        const linkStats = pageLinkStats.get(page.url)
            ? { ...pageLinkStats.get(page.url) }
            : { total: 0, pdf: 0, internal: 0, external: 0, image: 0 };

        const metadataBase = {
            source: 'webpage',
            sourceType: 'page',
            url: page.url,
            title: page.title,
            timestamp: page.timestamp,
            category: page.category || 'general',
            depth: page.depth || 0,
            wordCount: combinedWordCount || page.wordCount || 0,
            hasLinks: (linkStats.total || 0) > 0,
            linkStats,
            hasTables: Array.isArray(page.tables) && page.tables.length > 0,
            hasLists: Array.isArray(page.lists) && page.lists.length > 0,
            hasXHR: hasXhr,
            xhrCount: Array.isArray(page?.xhrResponses) ? page.xhrResponses.length : 0,
        };

        items.push({
            url: page.url,
            type: page.type || 'page',
            title: page.title || '',
            category: page.category || 'general',
            structuredText,
            wordCount: combinedWordCount || page.wordCount || 0,
            buildChunkMetadata: (index, totalChunks) => ({
                ...metadataBase,
                linkStats: JSON.stringify(metadataBase.linkStats || {}),
                chunkIndex: index,
                totalChunks,
            }),
        });
    }

    const pdfs = scrapedData.documents?.pdfs || [];
    for (const pdf of pdfs) {
        const pdfContent = pdf.text || pdf.content || '';
        if (!pdfContent || pdfContent.trim().length <= 100) {
            continue;
        }

        const structuredPdfText = [
            `PDF Title: ${pdf.title}`,
            `URL: ${pdf.url}`,
            `Category: ${pdf.category || 'general'}`,
            `Pages: ${pdf.pages}`,
            `Source Page: ${pdf.parentPageTitle || 'Unknown'}`,
            `Content: ${pdfContent}`
        ].filter(Boolean).join('\n\n');

        const metadataBase = {
            source: 'pdf',
            sourceType: 'pdf_document',
            url: pdf.url,
            title: pdf.title,
            pages: pdf.pages,
            timestamp: pdf.timestamp,
            category: pdf.category || 'general',
            sourceUrl: pdf.parentPageUrl,
            sourceTitle: pdf.parentPageTitle,
            wordCount: pdf.wordCount || countWords(structuredPdfText),
        };

        items.push({
            url: pdf.url,
            type: 'pdf',
            title: pdf.title || '',
            category: pdf.category || 'general',
            structuredText: structuredPdfText,
            wordCount: pdf.wordCount || countWords(structuredPdfText),
            buildChunkMetadata: (index, totalChunks) => ({
                ...metadataBase,
                linkStats: JSON.stringify(metadataBase.linkStats || {}),
                chunkIndex: index,
                totalChunks,
            }),
        });
    }

    if (scrapedData.links) {
        const linkContent = [
            `PDF Documents Available:`,
            scrapedData.links.pdf?.map(link =>
                `- ${link.text} - ${link.url} (Found on: ${link.sourceTitle})`
            ).join('\n') || 'No PDFs found',
            `\nInternal Pages:`,
            scrapedData.links.internal?.slice(0, 50).map(link =>
                `- ${link.text} - ${link.url}`
            ).join('\n') || 'No internal links found'
        ].join('\n');

        if (linkContent.trim().length > 100) {
            const virtualUrl = 'virtual://links-directory';
            const metadataBase = {
                source: 'links',
                sourceType: 'link_directory',
                type: 'directory',
                timestamp: scrapedData.metadata?.timestamp,
                totalPdfs: scrapedData.links.pdf?.length || 0,
                totalInternalLinks: scrapedData.links.internal?.length || 0,
                url: virtualUrl,
                title: 'Links Directory',
                category: 'virtual',
            };

            items.push({
                url: virtualUrl,
                type: 'page',
                title: 'Links Directory',
                category: 'virtual',
                structuredText: linkContent,
                wordCount: countWords(linkContent),
                buildChunkMetadata: (index, totalChunks) => ({
                    ...metadataBase,
                    linkStats: JSON.stringify(metadataBase.linkStats || {}),
                    chunkIndex: index,
                    totalChunks,
                }),
            });
        }
    }

    const categoryCounts = (scrapedData.pages || []).reduce((acc, page) => {
        const key = page.category || 'general';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    const buildCategoryLines = (counts, bullet) => {
        const entries = Object.entries(counts);
        if (!entries.length) return `${bullet} general: 0 pages`;
        return entries.map(([cat, count]) => `${bullet} ${cat}: ${count} pages`).join('\n');
    };

    const statsContent = [
        `NIT Jamshedpur Website Statistics and Overview:`,
        `Total Pages Scraped: ${scrapedData.statistics?.totalPages || 0}`,
        `Total PDF Documents: ${scrapedData.statistics?.totalPDFs || 0}`,
        `Total Links Found: ${scrapedData.statistics?.totalLinks || 0}`,
        `Categories Breakdown:`,
        buildCategoryLines(categoryCounts, '-'),
        `\nAvailable PDF Documents:`,
        scrapedData.documents?.pdfs?.map(pdf =>
            `- ${pdf.title} (${pdf.pages} pages, ${pdf.wordCount} words) - ${pdf.category}`
        ).join('\n') || 'No PDFs processed'
    ].join('\n');

    if (statsContent.trim().length > 100) {
        const virtualUrl = 'virtual://statistics';
        const metadataBase = {
            source: 'statistics',
            sourceType: 'summary',
            type: 'overview',
            timestamp: scrapedData.metadata?.timestamp,
            url: virtualUrl,
            title: 'Website Statistics Overview',
            category: 'virtual',
        };

        items.push({
            url: virtualUrl,
            type: 'page',
            title: 'Website Statistics Overview',
            category: 'virtual',
            structuredText: statsContent,
            wordCount: countWords(statsContent),
            buildChunkMetadata: (index, totalChunks) => ({
                ...metadataBase,
                linkStats: JSON.stringify(metadataBase.linkStats || {}),
                chunkIndex: index,
                totalChunks,
            }),
        });
    }

    return items;
}
