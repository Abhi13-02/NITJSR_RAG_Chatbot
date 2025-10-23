import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import puppeteer from 'puppeteer';
import axios from 'axios';
import pdfParse from 'pdf-parse';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class NITJSRScraper {
    constructor(options = {}) {
        this.browser = null;
        this.page = null;
        this.visited = new Set();
        this.toVisit = new Set();
        this.pdfUrls = new Set();
        this.maxPages = options.maxPages || 5; // Increased limit
        this.maxDepth = options.maxDepth || 3;   // Deeper crawling
        this.delay = options.delay || 1500;
        this.baseUrl = 'https://nitjsr.ac.in';
        
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
                pdfs: [],
                images: [],
                other: []
            },
            links: {
                internal: [],
                external: [],
                pdf: [],
                image: []
            },
            categories: {
                academics: [],
                admissions: [],
                placements: [],
                faculty: [],
                students: [],
                research: [],
                administration: [],
                news: [],
                events: [],
                departments: [],
                general: []
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
        const urlLower = url.toLowerCase();
        const contentLower = content.toLowerCase();
        
        if (urlLower.includes('placement') || contentLower.includes('placement') || 
            urlLower.includes('career') || contentLower.includes('career') ||
            urlLower.includes('training') || contentLower.includes('corporate')) {
            return 'placements';
        }
        if (urlLower.includes('admission') || urlLower.includes('apply') || 
            contentLower.includes('admission') || contentLower.includes('eligibility') ||
            urlLower.includes('entrance') || urlLower.includes('jee')) {
            return 'admissions';
        }
        if (urlLower.includes('academic') || urlLower.includes('syllabus') || 
            urlLower.includes('curriculum') || contentLower.includes('academic') ||
            urlLower.includes('course') || urlLower.includes('program')) {
            return 'academics';
        }
        if (urlLower.includes('faculty') || urlLower.includes('staff') || 
            contentLower.includes('professor') || contentLower.includes('faculty') ||
            urlLower.includes('teacher') || urlLower.includes('hod')) {
            return 'faculty';
        }
        if (urlLower.includes('student') || urlLower.includes('hostel') || 
            contentLower.includes('student life') || urlLower.includes('activity') ||
            urlLower.includes('club') || urlLower.includes('society')) {
            return 'students';
        }
        if (urlLower.includes('research') || urlLower.includes('publication') || 
            contentLower.includes('research') || urlLower.includes('phd') ||
            urlLower.includes('project') || urlLower.includes('innovation')) {
            return 'research';
        }
        if (urlLower.includes('department') || urlLower.includes('dept') || 
            urlLower.includes('/cse') || urlLower.includes('/ece') || urlLower.includes('/mech') ||
            urlLower.includes('/eee') || urlLower.includes('/civil') || urlLower.includes('/che') ||
            urlLower.includes('/mme') || urlLower.includes('/phy') || urlLower.includes('/chem') ||
            urlLower.includes('/math') || urlLower.includes('/hss')) {
            return 'departments';
        }
        if (urlLower.includes('news') || urlLower.includes('announcement') || 
            contentLower.includes('news') || urlLower.includes('notice') ||
            urlLower.includes('tender') || urlLower.includes('recruitment')) {
            return 'news';
        }
        if (urlLower.includes('event') || urlLower.includes('seminar') || 
            urlLower.includes('workshop') || contentLower.includes('event') ||
            urlLower.includes('conference') || urlLower.includes('symposium')) {
            return 'events';
        }
        if (urlLower.includes('admin') || urlLower.includes('office') || 
            urlLower.includes('registrar') || contentLower.includes('administration') ||
            urlLower.includes('director') || urlLower.includes('dean')) {
            return 'administration';
        }
        
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
            const skipExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.css', '.js', '.ico', '.svg', '.woff', '.woff2', '.ttf'];
            const skipPatterns = [
                'mailto:', 'tel:', 'javascript:', '#',
                'facebook.com', 'twitter.com', 'linkedin.com', 'youtube.com',
                'google.com', 'maps.google', 'instagram.com'
            ];
            
            const pathname = urlObj.pathname.toLowerCase();
            
            if (skipExtensions.some(ext => pathname.endsWith(ext))) {
                return false;
            }
            
            if (skipPatterns.some(pattern => url.toLowerCase().includes(pattern))) {
                return false;
            }
            
            return true;
        } catch (error) {
            return false;
        }
    }

    async scrapePage(url, depth = 0) {
        if (this.visited.has(url) || depth > this.maxDepth || this.visited.size >= this.maxPages) {
            return null;
        }

        console.log(`🔍 Scraping [${depth}/${this.maxDepth}] (${this.visited.size}/${this.maxPages}): ${url}`);
        this.visited.add(url);

        try {
            await this.page.goto(url, { 
                waitUntil: 'networkidle0', 
                timeout: 45000 
            });

            // Wait for dynamic content to load
            await this.page.waitForTimeout(this.delay);

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

            const pageData = await this.page.evaluate(() => {
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

                // Extract meta information
                const metaDescription = document.querySelector('meta[name="description"]');
                if (metaDescription) {
                    data.metadata.description = metaDescription.getAttribute('content') || '';
                }
                
                const metaKeywords = document.querySelector('meta[name="keywords"]');
                if (metaKeywords) {
                    data.metadata.keywords = metaKeywords.getAttribute('content') || '';
                }

                // Extract headings with hierarchy
                document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
                    data.headings.push({
                        level: parseInt(heading.tagName.charAt(1)),
                        text: heading.textContent.trim(),
                        id: heading.id || null
                    });
                });

                // Extract meaningful content with better selectors
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

            const allContent = [
                pageData.title,
                ...pageData.headings.map(h => h.text),
                ...pageData.content,
                ...pageData.tables.flat().flat(),
                ...pageData.lists.flat(),
                pageData.metadata.description,
                pageData.metadata.keywords
            ].filter(Boolean).join(' ');

            const processedPage = {
                url: url,
                timestamp: new Date().toISOString(),
                depth: depth,
                title: pageData.title,
                headings: pageData.headings,
                content: allContent,
                rawContent: pageData.content,
                tables: pageData.tables,
                lists: pageData.lists,
                links: pageData.links,
                metadata: pageData.metadata,
                category: this.categorizeUrl(url, allContent),
                wordCount: allContent.split(' ').length
            };

            this.scrapedData.categories[processedPage.category].push(processedPage);
            this.scrapedData.pages.push(processedPage);

            pageData.links.forEach(link => {
                try {
                    const fullUrl = new URL(link.href, url).href;
                    const linkData = {
                        url: fullUrl,
                        text: link.text,
                        title: link.title,
                        sourceUrl: url,
                        sourceTitle: pageData.title,
                        context: link.parentText
                    };

                    if (link.href.toLowerCase().includes('.pdf')) {
                        this.scrapedData.links.pdf.push(linkData);
                        this.pdfUrls.add(fullUrl);
                    } else if (link.href.toLowerCase().match(/\.(jpg|jpeg|png|gif|webp)$/)) {
                        this.scrapedData.links.image.push(linkData);
                    } else if (fullUrl.includes('nitjsr.ac.in')) {
                        this.scrapedData.links.internal.push(linkData);
                        if (this.isValidUrl(fullUrl) && !this.visited.has(fullUrl)) {
                            this.toVisit.add({url: fullUrl, depth: depth + 1});
                        }
                    } else {
                        this.scrapedData.links.external.push(linkData);
                    }
                } catch (error) {
                    // Invalid URL, skip
                }
            });

            console.log(`✅ Scraped: ${pageData.title} (${allContent.split(' ').length} words, ${pageData.links.length} links)`);
            return processedPage;

        } catch (error) {
            console.error(`❌ Failed to scrape ${url}:`, error.message);
            return null;
        }
    }

    async processPDFDocuments() {
        console.log(`📄 Processing ${this.pdfUrls.size} discovered PDF documents...`);
        
        const pdfArray = Array.from(this.pdfUrls);
        const maxPdfs = Math.min(pdfArray.length, 50); // Increased PDF limit

        for (let i = 0; i < maxPdfs; i++) {
            const pdfUrl = pdfArray[i];
            try {
                console.log(`📖 Processing PDF ${i + 1}/${maxPdfs}: ${pdfUrl}`);
                
                const response = await axios.get(pdfUrl, { 
                    responseType: 'arraybuffer',
                    timeout: 60000, // Increased timeout
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    maxContentLength: 50 * 1024 * 1024 // 50MB limit
                });

                const pdfData = await pdfParse(response.data);
                
                // Find the link information for this PDF
                const linkInfo = this.scrapedData.links.pdf.find(link => link.url === pdfUrl);
                
                const pdfDoc = {
                    url: pdfUrl,
                    title: linkInfo ? linkInfo.text : pdfUrl.split('/').pop(),
                    text: pdfData.text,
                    pages: pdfData.numpages,
                    category: this.categorizeUrl(pdfUrl, pdfData.text),
                    timestamp: new Date().toISOString(),
                    sourceUrl: linkInfo ? linkInfo.sourceUrl : '',
                    sourceTitle: linkInfo ? linkInfo.sourceTitle : '',
                    context: linkInfo ? linkInfo.context : '',
                    wordCount: pdfData.text.split(' ').length
                };

                this.scrapedData.documents.pdfs.push(pdfDoc);
                console.log(`✅ Processed PDF: ${pdfData.numpages} pages, ${pdfDoc.wordCount} words`);

            } catch (error) {
                console.error(`❌ Failed to process PDF ${pdfUrl}:`, error.message);
            }
        }
    }

    async scrapeComprehensive() {
        try {
            await this.initialize();
            
            //TODO: Add more start URLs
            const startUrls = [
                'https://nitjsr.ac.in/',
                'https://nitjsr.ac.in/Students/Placements',
                'https://nitjsr.ac.in/Students/Training-Placements',
                'https://nitjsr.ac.in/Admissions',
                'https://nitjsr.ac.in/Academics',
                'https://nitjsr.ac.in/Faculty',
                'https://nitjsr.ac.in/Research',
                'https://nitjsr.ac.in/Students',
                'https://nitjsr.ac.in/Administration',
                'https://nitjsr.ac.in/Departments/CSE',
                'https://nitjsr.ac.in/Departments/ECE',
                'https://nitjsr.ac.in/Departments/EEE',
                'https://nitjsr.ac.in/Departments/ME',
                'https://nitjsr.ac.in/Departments/CE',
                'https://nitjsr.ac.in/Departments/CHE',
                'https://nitjsr.ac.in/Departments/MME',
                'https://nitjsr.ac.in/Departments/Physics',
                'https://nitjsr.ac.in/Departments/Chemistry',
                'https://nitjsr.ac.in/Departments/Mathematics',
                'https://nitjsr.ac.in/Departments/HSS',
                'https://nitjsr.ac.in/About',
                'https://nitjsr.ac.in/Infrastructure',
                'https://nitjsr.ac.in/News',
                'https://nitjsr.ac.in/Events',
                'https://nitjsr.ac.in/Tenders',
                'https://nitjsr.ac.in/Recruitments',
                'https://nitjsr.ac.in/People/Faculty'//Doesn't work IDK why
            ];

            // Add starting URLs to visit queue
            startUrls.forEach(url => {
                this.toVisit.add({url: url, depth: 0});
            });

            console.log(`🌐 Starting enhanced comprehensive scrape of ${startUrls.length} main sections...`);

            while (this.toVisit.size > 0 && this.visited.size < this.maxPages) {
                const {url, depth} = Array.from(this.toVisit)[0];
                this.toVisit.delete(Array.from(this.toVisit)[0]);

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
        this.scrapedData.statistics.categorizedPages = Object.values(this.scrapedData.categories)
            .reduce((sum, category) => sum + category.length, 0);
    }

    async saveData() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '_');
        const filename = `nitjsr_enhanced_comprehensive_${timestamp}.json`;
        const filepath = path.join(__dirname, 'scraped_data', filename);

        // Ensure directory exists
        await fs.mkdir(path.dirname(filepath), { recursive: true });

        // Save the data
        await fs.writeFile(filepath, JSON.stringify(this.scrapedData, null, 2), 'utf8');

        const summary = {
            filename: filename,
            timestamp: new Date().toISOString(),
            totalPages: this.scrapedData.statistics.totalPages,
            totalPDFs: this.scrapedData.statistics.totalPDFs,
            totalLinks: this.scrapedData.statistics.totalLinks,
            categories: Object.keys(this.scrapedData.categories).map(cat => ({
                name: cat,
                count: this.scrapedData.categories[cat].length
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