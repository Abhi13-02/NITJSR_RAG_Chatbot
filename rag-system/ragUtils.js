import crypto from 'crypto';

export function hashString(input) {
    return crypto.createHash('sha256').update(input || '', 'utf8').digest('hex');
}

export function makeChunkId(url, index, textHash) {
    const urlHash = hashString(url).slice(0, 12);
    const chunkIndex = String(index).padStart(4, '0');
    const textHashShort = (textHash || '').slice(0, 10);
    return `${urlHash}:${chunkIndex}:${textHashShort}`;
}

export function nowIso() {
    return new Date().toISOString();
}

export function countWords(text) {
    return (text || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
}

export function collectXhrTextFragments(value, path = [], acc = [], depth = 0) {
    if (value === null || value === undefined) return acc;
    if (depth > 6) return acc;

    if (typeof value === 'string') {
        const cleaned = value.replace(/\s+/g, ' ').trim();
        if (!cleaned) return acc;
        const alphaChars = (cleaned.match(/[a-zA-Z]/g) || []).length;
        const minAlpha = Math.min(6, Math.ceil(cleaned.length * 0.2));
        if (alphaChars < minAlpha) return acc;
        const truncated = cleaned.length > 400 ? `${cleaned.slice(0, 400)}...` : cleaned;
        const label = path.length ? path.join(' > ') : '';
        acc.push(label ? `${label}: ${truncated}` : truncated);
        return acc;
    }

    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return acc;
    }

    if (Array.isArray(value)) {
        if (value.length > 50) return acc;
        value.forEach((item, idx) => collectXhrTextFragments(item, path.concat(`#${idx + 1}`), acc, depth + 1));
        return acc;
    }

    if (typeof value === 'object') {
        const entries = Object.entries(value || {}).slice(0, 50);
        entries.forEach(([key, val]) => collectXhrTextFragments(val, path.concat(key), acc, depth + 1));
    }

    return acc;
}

export function stringifyXhrData(data) {
    const fragments = collectXhrTextFragments(data, [], [], 0);
    if (!fragments.length) return '';
    return fragments.slice(0, 60).join('\n');
}

export function extractTextFromXhrResponses(responses = []) {
    if (!Array.isArray(responses) || !responses.length) return '';
    const sections = [];
    responses.forEach((response, index) => {
        if (!response || typeof response !== 'object') return;
        const dataText = stringifyXhrData(response.data);
        if (!dataText) return;
        const parts = [];
        if (response.url) parts.push(response.url);
        if (response.status !== undefined) parts.push(`status ${response.status}`);
        if (response.timestamp) parts.push(response.timestamp);
        const headerSuffix = parts.length ? ` (${parts.join(' | ')})` : '';
        sections.push(`XHR ${index + 1}${headerSuffix}\n${dataText}`);
    });
    return sections.join('\n\n');
}

export function tableToLines(table) {
    if (!table) return [];
    if (Array.isArray(table)) {
        return table
            .filter(row => Array.isArray(row))
            .map(row => row.map(cell => (cell ?? '')).join(' | ').trim())
            .filter(Boolean);
    }
    if (typeof table === 'object') {
        const lines = [];
        if (Array.isArray(table.headers) && table.headers.length) {
            const headerLine = table.headers.map(cell => cell ?? '').join(' | ').trim();
            if (headerLine) lines.push(headerLine);
        }
        if (Array.isArray(table.rows)) {
            table.rows.forEach(row => {
                if (!Array.isArray(row)) return;
                const line = row.map(cell => (cell ?? '')).join(' | ').trim();
                if (line) lines.push(line);
            });
        }
        return lines;
    }
    return [];
}

export function flattenTablesToText(tables = []) {
    if (!Array.isArray(tables) || !tables.length) return '';
    const blocks = tables
        .map(table => tableToLines(table).join('\n'))
        .filter(Boolean);
    return blocks.join('\n\n');
}
