export class PageExtractor {

    async extractFullDom(page) {
        return await page.evaluate(() => {
            const isHomePage =
                !window.location ||
                window.location.pathname === '/' ||
                window.location.pathname === '';
            if (!isHomePage) {
                const removeElements = (selectors = []) => {
                    selectors.forEach((selector) => {
                        document.querySelectorAll(selector).forEach((node) => node.remove());
                    });
                };
                removeElements([
                    'footer',
                    '#footer',
                    '.footer',
                    '.site-footer',
                    '.bottom-footer',
                ]);
                removeElements([
                    '#site_accessibility_icon',
                    '#site_accessibility',
                    '.__access-main-css',
                ]);
                removeElements(['[id*="accessibility"]', '[class*="accessibility"]']);
            }

            const data = {
                title: document.title || '',
                headings: [],
                content: [],
                links: [],
                metadata: {
                    description: '',
                    keywords: '',
                },
                tables: [],
                lists: [],
            };

            const metaDescription = document.querySelector('meta[name="description"]');
            if (metaDescription) {
                data.metadata.description = metaDescription.getAttribute('content') || '';
            }

            const metaKeywords = document.querySelector('meta[name="keywords"]');
            if (metaKeywords) {
                data.metadata.keywords = metaKeywords.getAttribute('content') || '';
            }

            document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
                data.headings.push({
                    level: parseInt(heading.tagName.charAt(1)),
                    text: heading.textContent.trim(),
                    id: heading.id || null,
                });
            });

            const contentSelectors = [
                'p',
                'div.content',
                '.main-content',
                '.page-content',
                '.article-content',
                '.description',
                '.info',
                '.details',
                '.summary',
                'article',
                'section',
                '.text-content',
            ];

            contentSelectors.forEach((selector) => {
                document.querySelectorAll(selector).forEach((element) => {
                    const text = element.textContent.trim();
                    if (
                        text &&
                        text.length > 30 &&
                        !data.content.some((existing) => existing.includes(text.substring(0, 50)))
                    ) {
                        data.content.push(text);
                    }
                });
            });

            document.querySelectorAll('table').forEach((table) => {
                const tableData = [];
                table.querySelectorAll('tr').forEach((row) => {
                    const rowData = [];
                    row.querySelectorAll('td, th').forEach((cell) => {
                        rowData.push(cell.textContent.trim());
                    });
                    if (rowData.length > 0) tableData.push(rowData);
                });
                if (tableData.length > 0) data.tables.push(tableData);
            });

            document.querySelectorAll('ul, ol').forEach((list) => {
                const listItems = [];
                list.querySelectorAll('li').forEach((item) => {
                    const text = item.textContent.trim();
                    if (text && text.length > 10) listItems.push(text);
                });
                if (listItems.length > 0) data.lists.push(listItems);
            });

            document.querySelectorAll('a[href]').forEach((link) => {
                const href = link.getAttribute('href');
                const text = link.textContent.trim();
                if (href) {
                    data.links.push({
                        href: href,
                        text: text || href,
                        title: link.getAttribute('title') || '',
                        className: link.className || '',
                        parentText: link.parentElement
                            ? link.parentElement.textContent.trim().substring(0, 100)
                            : '',
                    });
                }
            });

            return data;
        });
    }


    normalizeDomData(data) {
        const source = data && typeof data === 'object' ? data : {};
        const metadata =
            source.metadata && typeof source.metadata === 'object' ? source.metadata : {};
        return {
            title: source.title || '',
            headings: Array.isArray(source.headings) ? source.headings : [],
            content: Array.isArray(source.content) ? source.content : [],
            links: Array.isArray(source.links) ? source.links : [],
            metadata: {
                description: metadata.description || '',
                keywords: metadata.keywords || '',
            },
            tables: Array.isArray(source.tables) ? source.tables : [],
            lists: Array.isArray(source.lists) ? source.lists : [],
        };
    }


    async scrollPage(page) {
        await page.evaluate(() => {
            return new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 100;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if (totalHeight >= scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });
    }


    extractTableTextContent(tables) {
        if (!Array.isArray(tables)) return [];
        const lines = [];
        tables.forEach((table) => {
            if (!table) return;
            if (Array.isArray(table)) {
                table.forEach((row) => {
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
                    table.rows.forEach((row) => {
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
    }


    cleanLinks(links, pageUrl) {
        const cleanedLinks = [];
        const seenLinks = new Set();

        links.forEach((link) => {
            const rawHref = (link.href || '').trim();
            if (!rawHref) return;
            const lowerHref = rawHref.toLowerCase();
            if (
                lowerHref.startsWith('javascript:') ||
                lowerHref.startsWith('mailto:') ||
                lowerHref.startsWith('tel:')
            )
                return;
            if (rawHref === '#') return;

            let absoluteHref;
            try {
                absoluteHref = new URL(rawHref, pageUrl).href;
            } catch {
                return;
            }

            if (!seenLinks.has(absoluteHref)) {
                seenLinks.add(absoluteHref);
                cleanedLinks.push({
                    ...link,
                    href: absoluteHref,
                });
            }
        });

        return cleanedLinks;
    }

}