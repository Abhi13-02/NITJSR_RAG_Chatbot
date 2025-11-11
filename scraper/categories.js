export class PageCategorizer {

    constructor(baseUrl = 'https://nitjsr.ac.in') {
        this.baseUrl = baseUrl;
        this.CATEGORY_SEGMENT_MAP = {
            institute: 'institute',
            administration: 'administration',
            academics: 'academics',
            academic: 'academics',
            students: 'students',
            student: 'students',
            research: 'research',
            people: 'people',
            tender: 'tender',
            tenders: 'tender',
            notices: 'notices',
            notice: 'notices',
            cells: 'cells',
            cell: 'cells',
            facilities: 'facilities',
            facility: 'facilities',
            recruitments: 'recruitments',
            recruitment: 'recruitments',
            rti: 'rti',
            'computer-center': 'computer_center',
            computer_center: 'computer_center',
            'central-facilities': 'facilities',
            central_facilities: 'facilities',
        };
    }


    categorizeUrl(url, content = '') {
        // 1) Try URL-based
        const seg = this.getFirstSegment(url);
        if (this.CATEGORY_SEGMENT_MAP[seg]) return this.CATEGORY_SEGMENT_MAP[seg];

        // 2) Try removing plural (academics -> academic)
        const singular = seg.endsWith('s') ? seg.slice(0, -1) : null;
        if (singular && this.CATEGORY_SEGMENT_MAP[singular])
            return this.CATEGORY_SEGMENT_MAP[singular];

        // 3) Fallback on content analysis
        const fromContent = this.guessFromContent(content);
        if (fromContent) return fromContent;

        // 4) Default
        return 'general';
    }


    getFirstSegment(url) {
        try {
            const u = new URL(url, this.baseUrl);
            const seg = u.pathname.split('/').filter(Boolean)[0];
            return seg ? seg.toLowerCase() : '';
        } catch {
            return '';
        }
    }


    guessFromContent(text = '') {
        const checks = [
            {
                key: 'academics',
                rx: /\b(curriculum|syllabus|semester|academic|course|b\.?tech|m\.?tech|ph\.?d)\b/i,
            },
            {
                key: 'students',
                rx: /\b(admission|hostel|scholarship|student|exam|result|anti[-\s]?ragging)\b/i,
            },
            {
                key: 'research',
                rx: /\b(research|publication|project|grant|patent)\b/i,
            },
            {
                key: 'recruitments',
                rx: /\b(recruitment|walk[-\s]?in|faculty|advertisement)\b/i,
            },
            {
                key: 'tender',
                rx: /\b(tender|gem\b|bidding|quotation|procurement)\b/i,
            },
            {
                key: 'notices',
                rx: /\b(notice|notification|announcement|circular)\b/i,
            },
            {
                key: 'facilities',
                rx: /\b(library|laborator(y|ies)|workshop|sports|medical|guest\s*house)\b/i,
            },
            {
                key: 'administration',
                rx: /\b(registrar|dean|administration|establishment|senate)\b/i,
            },
        ];
        for (const { key, rx } of checks) if (rx.test(text)) return key;
        return null;
    }


    specialPdfCategory(url) {
        const lower = String(url || '').toLowerCase();
        if (lower.includes('/backend/uploads/tender/')) return 'tender';
        if (lower.includes('/backend/uploads/notices/')) return 'notices';
        if (lower.includes('/backend/uploads/recruitments/')) return 'notices';
        return null;
    }

}