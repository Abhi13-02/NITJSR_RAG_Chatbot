import puppeteer from 'puppeteer';

export class BrowserManager {
    constructor() {
        this.browser = null;
        this.page = null;
    }

    async initialize() {
        console.log('Initializing NIT JSR Website Scraper...');
        if (!puppeteer) {
            console.warn(
                'Puppeteer not available, scraper will work with limited functionality'
            );
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
            ],
        });
        this.page = await this.browser.newPage();

        await this.page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        );
        await this.page.setViewport({ width: 1920, height: 1080 });
        await this.page.setJavaScriptEnabled(true);

        console.log('Enhanced scraper initialized successfully');
    }


    async ensurePage() {
        // if we already have a page, and it's not closed, do nothing
        if (
            this.page &&
            typeof this.page.isClosed === 'function' &&
            !this.page.isClosed()
        ) {
            return;
        }

        // otherwise create a fresh page
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1920, height: 1080 });
        await this.page.setJavaScriptEnabled(true);
    }


    async cleanup() {
        if (this.browser) {
            await this.browser.close();
            console.log('🧹 Browser cleanup completed');
        }
    }

}