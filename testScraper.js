import { NITJSRScraper } from './scraper.js';

async function testScraper() {
    console.log('🧪 Starting Scraper Test...\n');

    const scraper = new NITJSRScraper({
        maxPages: 5,      // Only scrape 5 pages for testing
        maxDepth: 1,      // Only go 1 level deep
        delay: 1000       // 1 second delay between pages
    });

    try {
        console.log('📋 Test Configuration:');
        console.log('   - Max Pages: 5');
        console.log('   - Max Depth: 1');
        console.log('   - Delay: 1000ms\n');

        const result = await scraper.scrapeComprehensive();

        console.log('\n✅ Scraping Test Completed!\n');
        console.log('📊 Results Summary:');
        console.log('═══════════════════════════════════════════════════════\n');

        console.log('📄 Pages Scraped:', result.summary.totalPages);
        console.log('📑 PDF Documents Found:', result.summary.totalPDFs);
        console.log('🔗 Total Links Found:', result.summary.totalLinks);
        console.log('📂 Data saved to:', result.summary.filepath);

        console.log('\n📚 Categories Breakdown:');
        const categoriesSummary = result.summary.categories || [];
        categoriesSummary.forEach(cat => {
            if (cat.count > 0) {
                console.log(`   - ${cat.name}: ${cat.count} pages`);
            }
        });

        if (result.data.pages && result.data.pages.length > 0) {
            console.log('\n📋 Scraped Pages Details:');
            console.log('═══════════════════════════════════════════════════════\n');

            result.data.pages.forEach((page, index) => {
                console.log(`${index + 1}. ${page.title || 'Untitled'}`);
                console.log(`   URL: ${page.url}`);
                console.log(`   Category: ${page.category}`);
                console.log(`   Word Count: ${page.wordCount}`);
                console.log(`   Headings: ${page.headings?.length || 0}`);
                console.log(`   Links Found: ${page.links?.length || 0}`);
                console.log(`   Tables: ${page.tables?.length || 0}`);
                console.log(`   Lists: ${page.lists?.length || 0}`);

                if (page.content) {
                    const preview = page.content.substring(0, 150).replace(/\s+/g, ' ');
                    console.log(`   Preview: ${preview}...`);
                }
                console.log('');
            });
        }

        if (result.data.links.pdf && result.data.links.pdf.length > 0) {
            console.log('📑 PDF Links Found:');
            console.log('═══════════════════════════════════════════════════════\n');

            result.data.links.pdf.slice(0, 10).forEach((pdf, index) => {
                console.log(`${index + 1}. ${pdf.text}`);
                console.log(`   URL: ${pdf.url}`);
                console.log(`   Source: ${pdf.sourceTitle}`);
                console.log('');
            });

            if (result.data.links.pdf.length > 10) {
                console.log(`   ... and ${result.data.links.pdf.length - 10} more PDFs\n`);
            }
        }

        if (result.data.links.internal && result.data.links.internal.length > 0) {
            console.log('🔗 Internal Links Sample (first 10):');
            console.log('═══════════════════════════════════════════════════════\n');

            result.data.links.internal.slice(0, 10).forEach((link, index) => {
                console.log(`${index + 1}. ${link.text || 'No text'}`);
                console.log(`   URL: ${link.url}`);
                console.log('');
            });

            if (result.data.links.internal.length > 10) {
                console.log(`   ... and ${result.data.links.internal.length - 10} more internal links\n`);
            }
        }

        console.log('\n💡 Tip: Check the saved JSON file for complete data:');
        console.log(`   ${result.summary.filepath}\n`);

    } catch (error) {
        console.error('\n❌ Test Failed:', error.message);
        console.error('Stack trace:', error.stack);
        process.exit(1);
    }
}

testScraper();
