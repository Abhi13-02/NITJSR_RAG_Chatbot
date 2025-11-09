import fs from 'fs/promises';
import path from 'path';

export function buildScrapeOptions(payload = {}) {
    if (!payload || typeof payload !== 'object') {
        return {};
    }

    const options = {};
    if (payload.maxPages !== undefined) {
        options.maxPages = payload.maxPages;
    }

    const depthValue = payload.maxDepth ?? payload.depth;
    if (depthValue !== undefined) {
        options.maxDepth = depthValue;
    }

    const priorityValue = payload.priorityUrls ?? payload.priorityUrl;
    if (priorityValue !== undefined) {
        options.priorityUrls = priorityValue;
    }

    const restrictedValue = payload.restrictedUrls ?? payload.restrictedUrl;
    if (restrictedValue !== undefined) {
        options.restrictedUrls = restrictedValue;
    }

    return options;
}



export async function loadLatestScrapedData(__dirname) {
    const dataDir = path.join(__dirname, 'scraped_data');
    try {
        const files = await fs.readdir(dataDir);
        const latestFile = files
            .filter((f) => f.endsWith('.json'))
            .sort()
            .reverse()[0];
        if (!latestFile) return null;
        const filePath = path.join(dataDir, latestFile);
        const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
        return { data, filename: latestFile, filepath: filePath };
    } catch (error) {
        return null;
    }
}



export function validateEnvironment() {
    const required = [
        'GEMINI_API_KEY',
        'COHERE_API_KEY',
        'PINECONE_API_KEY',
        'PINECONE_INDEX_NAME',
        'PINECONE_ENVIRONMENT',
    ];
    const missing = required.filter((key) => !process.env[key] || process.env[key].trim() === '');

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    console.log('Environment variables validated');
    console.log(`Using Pinecone index: ${process.env.PINECONE_INDEX_NAME.trim()}`);
    console.log(`Pinecone environment: ${process.env.PINECONE_ENVIRONMENT.trim()}`);
}