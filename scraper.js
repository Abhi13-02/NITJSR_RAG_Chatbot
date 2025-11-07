import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import puppeteer from "puppeteer";
import axios from "axios";
import pdfParse from "pdf-parse";
import zlib from "zlib";

import { exec as _exec } from "child_process";
import { promisify } from "util";
const exec = promisify(_exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class NITJSRScraper {
  constructor(options = {}) {
    this.browser = null;
    this.page = null;
    this.visited = new Set();
    this.toVisit = new Set();
    this.pdfUrls = new Set();
    this.pdfUrlOriginals = new Map();
    this.maxPages = options.maxPages || 5; // Increased limit
    this.maxDepth = options.maxDepth || 3; // Deeper crawling
    this.delay = options.delay || 1500;
    this.baseUrl = "https://nitjsr.ac.in";
    this.priorityUrls = Array.isArray(options.priorityUrls)
      ? options.priorityUrls
      : ["https://nitjsr.ac.in/Institute/About_NITJSR"];
    this.priorityQueue = [];
    this.pageXHRCache = new Map();
    this.excludeUrls = new Set();
    if (Array.isArray(options.excludeUrls)) {
      options.excludeUrls.forEach((raw) => {
        try {
          const normalized = this.normalizeUrl(raw);
          if (normalized) {
            this.excludeUrls.add(normalized.toLowerCase());
          }
        } catch {
          // ignore invalid exclude URL
        }
      });
    }

    this.scrapedData = {
      metadata: {
        timestamp: new Date().toISOString(),
        source: "NIT Jamshedpur Official Website",
        baseUrl: this.baseUrl,
        scrapeType: "enhanced_comprehensive",
        maxPages: this.maxPages,
        maxDepth: this.maxDepth,
      },
      pages: [],
      documents: {
        pdfs: [],
      },
      links: {
        internal: [],
        external: [],
        pdf: [],
        image: [],
      },
      statistics: {
        totalPages: 0,
        totalPDFs: 0,
        totalImages: 0,
        totalLinks: 0,
        categorizedPages: 0,
      },
      pagePdfRanking: [] 
    };

    // Allowlist for eligible tender/notices PDFs from sitemap
    this.sitemapPdfPolicy = {
      allow: new Set(), // normalized lowercase URLs allowed by date policy
      dates: new Map(), // normalized lowercase URL -> ISO date string (from sitemap lastmod or HEAD)
    };
  }

  async initialize() {
    console.log("🚀 Initializing NIT JSR Website Scraper...");
    if (!puppeteer) {
      console.warn(
        "⚠️ Puppeteer not available, scraper will work with limited functionality"
      );
      return;
    }

    this.browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor",
      ],
    });
    this.page = await this.browser.newPage();

    await this.page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );
    await this.page.setViewport({ width: 1920, height: 1080 });

    await this.page.setJavaScriptEnabled(true);

    console.log("✅ Enhanced scraper initialized successfully");
  }

    // make sure we always have a live puppeteer page
  async ensurePage() {
    // if we already have a page and it's not closed, do nothing
    if (this.page && typeof this.page.isClosed === "function" && !this.page.isClosed()) {
      return;
    }

    // otherwise create a fresh page
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1920, height: 1080 });
    await this.page.setJavaScriptEnabled(true);
  }


  categorizeUrl(url, content = "") {
    // --- Smarter, resilient categorization ---
    const CATEGORY_SEGMENT_MAP = {
      institute: "institute",
      administration: "administration",
      academics: "academics",
      academic: "academics", // catch singular
      students: "students",
      student: "students",
      research: "research",
      people: "people",
      tender: "tender",
      tenders: "tender",
      notices: "notices",
      notice: "notices",
      cells: "cells",
      cell: "cells",
      facilities: "facilities",
      facility: "facilities",
      recruitments: "recruitments",
      recruitment: "recruitments",
      rti: "rti",
      "computer-center": "computer_center",
      computer_center: "computer_center",
      "central-facilities": "facilities",
      central_facilities: "facilities",
    };

    // helper: get first path segment from URL
    const getFirstSegment = (url) => {
      try {
        const u = new URL(url, this.baseUrl || "https://nitjsr.ac.in");
        const seg = u.pathname.split("/").filter(Boolean)[0];
        return seg ? seg.toLowerCase() : "";
      } catch {
        return "";
      }
    };

    // helper: content-based fallback
    const guessFromContent = (text = "") => {
      const checks = [
        {
          key: "academics",
          rx: /\b(curriculum|syllabus|semester|academic|course|b\.?tech|m\.?tech|ph\.?d)\b/i,
        },
        {
          key: "students",
          rx: /\b(admission|hostel|scholarship|student|exam|result|anti[-\s]?ragging)\b/i,
        },
        {
          key: "research",
          rx: /\b(research|publication|project|grant|patent)\b/i,
        },
        {
          key: "recruitments",
          rx: /\b(recruitment|walk[-\s]?in|faculty|advertisement)\b/i,
        },
        {
          key: "tender",
          rx: /\b(tender|gem\b|bidding|quotation|procurement)\b/i,
        },
        {
          key: "notices",
          rx: /\b(notice|notification|announcement|circular)\b/i,
        },
        {
          key: "facilities",
          rx: /\b(library|laborator(y|ies)|workshop|sports|medical|guest\s*house)\b/i,
        },
        {
          key: "administration",
          rx: /\b(registrar|dean|administration|establishment|senate)\b/i,
        },
      ];
      for (const { key, rx } of checks) if (rx.test(text)) return key;
      return null;
    };

    // 1) Try URL-based
    const seg = getFirstSegment(url);
    if (CATEGORY_SEGMENT_MAP[seg]) return CATEGORY_SEGMENT_MAP[seg];

    // 2) Try removing plural (academics -> academic)
    const singular = seg.endsWith("s") ? seg.slice(0, -1) : null;
    if (singular && CATEGORY_SEGMENT_MAP[singular])
      return CATEGORY_SEGMENT_MAP[singular];

    // 3) Fallback on content analysis
    const fromContent = guessFromContent(content);
    if (fromContent) return fromContent;

    // 4) Default
    return "general";
  }

  // --- Helpers for sitemap-based PDF policy ---
  monthsAgo(months = 0) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setMonth(d.getMonth() - Number(months || 0));
    return d;
  }

  getCategoryMaxAgeMonths(category = "") {
    const c = String(category || "").toLowerCase();
    if (c === "tender") return 6;
    if (
      c === "notices" ||
      c === "notice" ||
      c === "notification" ||
      c === "notifications" ||
      c == "recruitments"
    )
      return 1;
    return null; // no limit for other categories
  }

  specialPdfCategory(url) {
    const lower = String(url || "").toLowerCase();
    if (lower.includes("/backend/uploads/tender/")) return "tender";
    if (lower.includes("/backend/uploads/notices/")) return "notices";
    if (lower.includes("/backend/uploads/recruitments/")) return "notices";
    return null;
  }

  normalizePolicyKey(url) {
    const n = this.normalizeForComparison(url);
    return n || (typeof url === "string" ? url.trim().toLowerCase() : null);
  }

  isPdfAllowedByPolicy(url, category) {
    const cat = (category || this.specialPdfCategory(url) || "").toLowerCase();
    if (cat === "tender" || cat === "notices") {
      const key = this.normalizePolicyKey(url);
      return !!(
        key &&
        this.sitemapPdfPolicy &&
        this.sitemapPdfPolicy.allow &&
        this.sitemapPdfPolicy.allow.has(key)
      );
    }
    return true; // other categories unfiltered
  }

  isValidUrl(url) {
    try {
      const urlObj = new URL(url, this.baseUrl);
      const normalizedHref = urlObj.href.toLowerCase();

      // Only scrape nitjsr.ac.in domain
      if (!urlObj.hostname.includes("nitjsr.ac.in")) {
        return false;
      }

      // Skip certain file types and external links
      const skipExtensions = [
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".css",
        ".js",
        ".ico",
        ".svg",
        ".woff",
        ".woff2",
        ".ttf",
        ".map",
      ];
      const skipPatterns = [
        "mailto:",
        "tel:",
        "javascript:",
        "#",
        "/assets/",
        "/static/",
        "/locales/",
        "/images/",
        "/fonts/",
        "facebook.com",
        "twitter.com",
        "linkedin.com",
        "youtube.com",
        "google.com",
        "maps.google",
        "instagram.com",
      ];

      const pathname = urlObj.pathname.toLowerCase();
      const full = normalizedHref;

      if (skipExtensions.some((ext) => pathname.endsWith(ext))) return false;
      if (skipPatterns.some((pattern) => full.includes(pattern))) return false;

      return true;
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
          typeof value === "string" ? value.trim() : String(value).trim()
        )
        .filter(Boolean);
    }
    if (typeof input === "string") {
      return input
        .split(",")
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

  applyRuntimeOptions(runOptions = {}) {
    const options =
      runOptions && typeof runOptions === "object" ? runOptions : {};
    const previousState = {
      maxPages: this.maxPages,
      maxDepth: this.maxDepth,
      priorityUrls: Array.isArray(this.priorityUrls)
        ? [...this.priorityUrls]
        : [],
      excludeUrls: new Set(this.excludeUrls),
      metadata: this.scrapedData?.metadata
        ? {
            maxPages: this.scrapedData.metadata.maxPages,
            maxDepth: this.scrapedData.metadata.maxDepth,
          }
        : null,
    };

    const parsePositiveInt = (value) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return null;
      const intVal = Math.floor(num);
      return intVal > 0 ? intVal : null;
    };

    const overrideMaxPages = parsePositiveInt(options.maxPages);
    if (overrideMaxPages) {
      this.maxPages = overrideMaxPages;
      if (this.scrapedData?.metadata) {
        this.scrapedData.metadata.maxPages = overrideMaxPages;
      }
    }

    const depthInput = options.maxDepth ?? options.depth;
    const overrideDepth = parsePositiveInt(depthInput);
    if (overrideDepth) {
      this.maxDepth = overrideDepth;
      if (this.scrapedData?.metadata) {
        this.scrapedData.metadata.maxDepth = overrideDepth;
      }
    }

    const priorityList = this.normalizeUrlCollection(
      options.priorityUrls ?? options.priorityUrl
    );
    if (priorityList.length > 0) {
      this.priorityUrls = priorityList;
    }

    const restrictedSeed =
      options.restrictedUrls ??
      options.restrictedUrl ??
      options.excludeUrls ??
      options.excludeUrl;
    const extraExclusions = this.normalizeUrlCollection(restrictedSeed);
    if (extraExclusions.length > 0) {
      extraExclusions.forEach((url) => {
        const key =
          this.normalizeForComparison(url) || String(url || "").toLowerCase();
        if (key) {
          this.excludeUrls.add(key);
        }
      });
    }

    return () => {
      this.maxPages = previousState.maxPages;
      this.maxDepth = previousState.maxDepth;
      this.priorityUrls = previousState.priorityUrls;
      this.excludeUrls = new Set(previousState.excludeUrls);
      if (previousState.metadata && this.scrapedData?.metadata) {
        this.scrapedData.metadata.maxPages = previousState.metadata.maxPages;
        this.scrapedData.metadata.maxDepth = previousState.metadata.maxDepth;
      }
    };
  }

  isExcluded(url) {
    const key = this.normalizeForComparison(url);
    if (!key) return false;

    // check exact match or same with trailing slash
    if (this.excludeUrls.has(key)) return true;
    if (this.excludeUrls.has(key.endsWith("/") ? key.slice(0, -1) : key + "/"))
      return true;

    return false;
  }

  // --- NEW: Sitemap loader (minimal changes, no external deps) ---
  async loadSitemapUrls() {
    const candidates = [
      `${this.baseUrl.replace(/\/+$/, "")}/sitemap.xml`,
      `${this.baseUrl.replace(/\/+$/, "")}/sitemap_index.xml`,
    ];
    const discovered = new Set();

    const fetchXml = async (url) => {
      try {
        const res = await axios.get(url, {
          responseType: "arraybuffer",
          timeout: 30000,
        });
        let buf = Buffer.from(res.data);
        const ct = (res.headers["content-type"] || "").toLowerCase();
        const ce = (res.headers["content-encoding"] || "").toLowerCase();
        if (url.endsWith(".gz") || ce.includes("gzip")) {
          try {
            buf = zlib.gunzipSync(buf);
          } catch {}
        }
        return buf.toString("utf8");
      } catch {
        return null;
      }
    };

    const extractLocs = (xml) => {
      if (!xml) return [];
      const locs = [];
      const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
      let m;
      while ((m = re.exec(xml)) !== null) {
        locs.push(m[1].trim());
      }
      return locs;
    };

    const extractUrlEntries = (xml) => {
      if (!xml) return [];
      const entries = [];
      const re = /<url>([\s\S]*?)<\/url>/gi;
      let m;
      while ((m = re.exec(xml)) !== null) {
        const block = m[1];
        const locMatch = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(block);
        if (!locMatch) continue;
        const lastmodMatch = /<lastmod>\s*([^<]+)\s*<\/lastmod>/i.exec(block);
        entries.push({
          loc: locMatch[1].trim(),
          lastmod: lastmodMatch ? lastmodMatch[1].trim() : null,
        });
      }
      return entries;
    };

    const handleSitemap = async (url) => {
      const xml = await fetchXml(url);
      if (!xml) return;

      // If it's a sitemap index, recurse into child sitemaps
      if (/<sitemapindex[\s>]/i.test(xml)) {
        const locs = extractLocs(xml);
        for (const loc of locs) {
          await handleSitemap(loc);
        }
        return;
      }

      // If it's a urlset, collect URLs with optional lastmod
      if (/<urlset[\s>]/i.test(xml)) {
        const entries = extractUrlEntries(xml);
        if (entries && entries.length) {
          const now = new Date();
          const cutoffTender = this.monthsAgo(6);
          const cutoffNotices = this.monthsAgo(1);
          for (const e of entries) {
            try {
              const fullUrl = new URL(e.loc, this.baseUrl).href;
              const isPdf = fullUrl.toLowerCase().endsWith(".pdf");
              if (!isPdf) {
                discovered.add(fullUrl);
                continue;
              }

              // Only enforce policy for backend tender/notices PDFs
              const special = this.specialPdfCategory(fullUrl);
              if (special === "tender" || special === "notices") {
                let ok = false;
                if (e.lastmod) {
                  const d = new Date(e.lastmod);
                  if (!isNaN(d)) {
                    if (
                      (special === "tender" && d >= cutoffTender) ||
                      (special === "notices" && d >= cutoffNotices)
                    ) {
                      ok = true;
                      const key = this.normalizePolicyKey(fullUrl);
                      if (key) {
                        this.sitemapPdfPolicy.allow.add(key);
                        this.sitemapPdfPolicy.dates.set(key, d.toISOString());
                      }
                    }
                  }
                }
                // If lastmod missing or invalid, do not allow by strict sitemap policy
                if (!ok) {
                  // skip
                }
              } else {
                // Other PDFs: no policy gating, but record date if present for enrichment
                if (e.lastmod) {
                  const d = new Date(e.lastmod);
                  if (!isNaN(d)) {
                    const key = this.normalizePolicyKey(fullUrl);
                    if (key)
                      this.sitemapPdfPolicy.dates.set(key, d.toISOString());
                  }
                }
              }
            } catch {
              // ignore bad url entries
            }
          }
          return;
        }

        // Fallback when there are only <loc> tags
        const urls = extractLocs(xml);
        for (const u of urls) discovered.add(u);
        return;
      }

      // Fallback: try to parse any <loc> tags anyway
      const urls = extractLocs(xml);
      for (const u of urls) discovered.add(u);
    };

    for (const c of candidates) {
      await handleSitemap(c);
    }

    let enqueued = 0;

    for (const raw of discovered) {
      try {
        const fullUrl = new URL(raw, this.baseUrl).href;
        if (fullUrl.toLowerCase().endsWith(".pdf")) continue;
        if (this.isExcluded(fullUrl)) continue;
        const visitKey = this.normalizeForComparison(fullUrl);
        if (!visitKey) continue;
        if (this.isValidUrl(fullUrl) && !this.visited.has(visitKey)) {
          this.toVisit.add({ url: fullUrl, depth: 0 });
          enqueued++;
        }
      } catch {
        // ignore malformed entries
      }
    }

    console.log(
      `🧭 Sitemap: discovered ${discovered.size} URLs, enqueued ${enqueued} HTML pages, skipped direct PDF downloads`
    );
  }

  capturePageXHR(page, pageUrl, pageMeta = { title: "" }) {
    const ignorePatterns = [
      "translation.json",
      "frontendlive",
      "trigger-count",
      "/locales/",
      "/i18n",
    ];
    const processedResponses = new Set();
    const cacheKey = this.normalizeForComparison(pageUrl) || pageUrl;
    this.pageXHRCache.set(cacheKey, []);
    const getPageXHRStore = () => {
      if (!this.pageXHRCache.has(cacheKey)) {
        this.pageXHRCache.set(cacheKey, []);
      }
      return this.pageXHRCache.get(cacheKey);
    };
    const addPdfFromItem = (item) => {
      if (!item || typeof item !== "object") return;
      const candidateFields = ["link", "url", "file", "document", "path"];
      let pdfValue = null;
      for (const field of candidateFields) {
        const value = item[field];
        if (typeof value === "string" && value.toLowerCase().includes(".pdf")) {
          pdfValue = value;
          break;
        }
        if (!pdfValue && value && typeof value === "object") {
          const nestedCandidate =
            typeof value.url === "string"
              ? value.url
              : typeof value.href === "string"
              ? value.href
              : null;
          if (
            nestedCandidate &&
            nestedCandidate.toLowerCase().includes(".pdf")
          ) {
            pdfValue = nestedCandidate;
            break;
          }
        }
      }
      if (!pdfValue) return;

      let pdfUrl;
      try {
        pdfUrl = new URL(pdfValue, pageUrl).href;
      } catch {
        return;
      }
      // Determine category and apply item-based date policy for tenders/notices
      const special = this.specialPdfCategory(pdfUrl);
      let policyCat = special || null;
      try {
        if (!policyCat && Array.isArray(item.notification_for)) {
          const tags = item.notification_for
            .map(String)
            .map((s) => s.toLowerCase());
          if (
            tags.includes("announcement") ||
            tags.includes("notice") ||
            tags.includes("notifications") ||
            tags.includes("recruitments")
          ) {
            policyCat = "notices";
          }
        }
      } catch {}
      const preCat =
        policyCat ||
        this.categorizeUrl(
          pdfUrl,
          `${item?.title || ""} ${item?.notification || ""}`.trim()
        );

      const getDateFromItem = (obj) => {
        if (!obj || typeof obj !== "object") return null;
        const keys = [
          "time",
          "date",
          "idate",
          "published_on",
          "created_at",
          "updated_at",
          "end_time",
        ];
        for (const k of keys) {
          const v = obj[k];
          if (v == null) continue;
          if (typeof v === "number") {
            const ms = v > 1e12 ? v : v * 1000;
            const d = new Date(ms);
            if (!isNaN(d)) return d;
            continue;
          }
          if (typeof v === "string") {
            const t = v.trim();
            if (!t) continue;
            if (/^\d{10,}$/.test(t)) {
              const n = parseInt(t, 10);
              const ms = n > 1e12 ? n : n * 1000;
              const d = new Date(ms);
              if (!isNaN(d)) return d;
            }
            const d = new Date(t);
            if (!isNaN(d)) return d;
          }
        }
        return null;
      };
      const itemDate = getDateFromItem(item);
      if (
        (preCat === "tender" ||
          preCat === "notices" ||
          preCat == "recruitments") &&
        itemDate
      ) {
        const months = this.getCategoryMaxAgeMonths(preCat);
        if (months) {
          const cutoff = this.monthsAgo(months);
          if (itemDate < cutoff) {
            // Skip old tender/notice per item-provided date
            return;
          }
        }
      }

      const titleCandidates = [
        item.title,
        item.name,
        item.notification,
        item.subject,
        item.fileName,
        item.caption,
        item.heading,
      ];
      const pdfTitle = (
        titleCandidates.find(
          (v) => typeof v === "string" && v.trim().length > 0
        ) ||
        pdfUrl.split("/").pop() ||
        ""
      ).trim();

      const textCandidates = [
        item.description,
        item.summary,
        item.details,
        item.note,
        item.content,
        item.notification,
        pdfTitle,
      ];
      const textContent = (
        textCandidates.find(
          (v) => typeof v === "string" && v.trim().length > 0
        ) || ""
      ).trim();
      const wordCount = textContent
        ? textContent.split(/\s+/).filter(Boolean).length
        : 0;
      const parentTitle = (pageMeta && pageMeta.title) || "";
      const timestamp = new Date().toISOString();

      const pdfDoc = {
        url: pdfUrl,
        title: pdfTitle,
        text: textContent,
        pages: 0,
        category: preCat,
        timestamp,
        parentPageUrl: pageUrl,
        parentPageTitle: parentTitle,
        sourceUrl: pageUrl,
        sourceTitle: parentTitle,
        wordCount,
      };

      // Attach publishedAt from item when available
      if (itemDate && !isNaN(itemDate)) {
        pdfDoc.publishedAt = itemDate.toISOString();
        pdfDoc.publishedAtSource = "item";
      } else {
        // fallback to sitemap date if we have one
        try {
          const key = this.normalizePolicyKey(pdfUrl);
          const iso =
            key && this.sitemapPdfPolicy && this.sitemapPdfPolicy.dates
              ? this.sitemapPdfPolicy.dates.get(key)
              : null;
          if (iso) {
            pdfDoc.publishedAt = iso;
            pdfDoc.publishedAtSource = "sitemap";
          }
        } catch {}
      }

      const existingIndex = this.scrapedData.documents.pdfs.findIndex(
        (doc) => doc.url === pdfUrl
      );
      if (existingIndex !== -1) {
        const existing = this.scrapedData.documents.pdfs[existingIndex];
        this.scrapedData.documents.pdfs[existingIndex] = {
          ...existing,
          ...pdfDoc,
          wordCount: pdfDoc.wordCount || existing.wordCount || 0,
          pages: pdfDoc.pages || existing.pages || 0,
          text: pdfDoc.text || existing.text || "",
          category: pdfDoc.category || existing.category || "general",
          timestamp: pdfDoc.timestamp || existing.timestamp,
          parentPageUrl: pdfDoc.parentPageUrl || existing.parentPageUrl,
          parentPageTitle: pdfDoc.parentPageTitle || existing.parentPageTitle,
          sourceUrl: pdfDoc.sourceUrl || existing.sourceUrl,
          sourceTitle: pdfDoc.sourceTitle || existing.sourceTitle,
          publishedAt: pdfDoc.publishedAt || existing.publishedAt || null,
          publishedAtSource:
            pdfDoc.publishedAtSource || existing.publishedAtSource || null,
        };
      } else {
        this.scrapedData.documents.pdfs.push(pdfDoc);
      }

      const linkEntry = {
        url: pdfUrl,
        text: pdfTitle || pdfUrl,
        title: pdfTitle || pdfUrl,
        sourceUrl: pageUrl,
        sourceTitle: parentTitle,
        context: textContent,
      };
      if (
        !this.scrapedData.links.pdf.some(
          (link) => link.url === pdfUrl && link.sourceUrl === pageUrl
        )
      ) {
        this.scrapedData.links.pdf.push(linkEntry);
      }

      const normalizedPdfUrl = pdfUrl.split("#")[0].split("?")[0].toLowerCase();
      const before = this.pdfUrls.size;
      this.pdfUrls.add(normalizedPdfUrl);
      if (!this.pdfUrlOriginals.has(normalizedPdfUrl)) {
        this.pdfUrlOriginals.set(normalizedPdfUrl, pdfUrl);
      }
      const after = this.pdfUrls.size;
      if (after > before) {
        console.log(
          `[pdf-added] ${normalizedPdfUrl}  (source: ${pageUrl})  totalUniquePDFs=${after}`
        );
      }
    };

    const processItems = (items) => {
      if (
        !Array.isArray(items) ||
        !items.length ||
        typeof items[0] !== "object"
      )
        return;
      items.forEach(addPdfFromItem);
    };

    const handler = async (response) => {
      try {
        const request = response.request();
        const resourceType = request.resourceType ? request.resourceType() : "";
        if (resourceType !== "xhr" && resourceType !== "fetch") return;

        const resUrl = response.url();
        const lowerUrl = resUrl.toLowerCase();
        if (ignorePatterns.some((pattern) => lowerUrl.includes(pattern)))
          return;
        if (processedResponses.has(resUrl)) return;
        processedResponses.add(resUrl);

        if (typeof response.ok === "function" && !response.ok()) return;
        const headers =
          (typeof response.headers === "function" ? response.headers() : {}) ||
          {};
        const contentType = (
          headers["content-type"] ||
          headers["Content-Type"] ||
          ""
        ).toLowerCase();
        if (contentType && !contentType.includes("json")) return;

        let jsonData;
        try {
          jsonData = await response.json();
        } catch {
          return;
        }

        if (
          !jsonData ||
          (typeof jsonData !== "object" && !Array.isArray(jsonData))
        ) {
          return;
        }

        getPageXHRStore().push({
          url: request.url(),
          status: response.status(),
          timestamp: new Date().toISOString(),
          data: jsonData,
        });

        if (Array.isArray(jsonData)) {
          processItems(jsonData);
          return;
        }

        if (jsonData && typeof jsonData === "object") {
          const candidateKeys = ["data", "results", "items", "records", "list"];
          for (const key of candidateKeys) {
            if (Array.isArray(jsonData[key])) {
              processItems(jsonData[key]);
            }
          }
        }
      } catch {
        // Ignore individual response errors
      }
    };

    page.on("response", handler);
    return () => page.off("response", handler);
  }

  // --- END: Sitemap loader ---
  async scrapePage(url, depth = 0) {
    if (this.isExcluded(url)) {
      return null;
    }
    if (!this.isValidUrl(url)) {
      return null;
    }
    const visitKey = this.normalizeForComparison(url) || url;
    if (
      this.visited.has(visitKey) ||
      depth > this.maxDepth ||
      this.visited.size >= this.maxPages
    ) {
      return null;
    }

    console.log(
      `🔍 Scraping [${depth}/${this.maxDepth}] (${this.visited.size}/${this.maxPages}): ${url}`
    );
    this.visited.add(visitKey);

    // it ensurese that the scraper page lives
    await this.ensurePage();

    const pageMeta = { title: "" };
    let detachXHR = this.capturePageXHR(this.page, url, pageMeta);
    let latestResolvedKey = null;

    try {
      await this.page.goto(url, {
        waitUntil: "networkidle0",
        timeout: 45000,
      });

      // Wait for dynamic content to load
      await this.page.waitForTimeout(this.delay);

      pageMeta.title = (await this.page.title().catch(() => "")) || "";

      const extractFullDom = async () => {
        return await this.page.evaluate(() => {
          const isHomePage =
            !window.location ||
            window.location.pathname === "/" ||
            window.location.pathname === "";
          if (!isHomePage) {
            const removeElements = (selectors = []) => {
              selectors.forEach((selector) => {
                document
                  .querySelectorAll(selector)
                  .forEach((node) => node.remove());
              });
            };
            removeElements([
              "footer",
              "#footer",
              ".footer",
              ".site-footer",
              ".bottom-footer",
            ]);
            removeElements([
              "#site_accessibility_icon",
              "#site_accessibility",
              ".__access-main-css",
            ]);
            removeElements([
              '[id*="accessibility"]',
              '[class*="accessibility"]',
            ]);
          }

          const data = {
            title: document.title || "",
            headings: [],
            content: [],
            links: [],
            metadata: {
              description: "",
              keywords: "",
            },
            tables: [],
            lists: [],
          };

          const metaDescription = document.querySelector(
            'meta[name="description"]'
          );
          if (metaDescription) {
            data.metadata.description =
              metaDescription.getAttribute("content") || "";
          }

          const metaKeywords = document.querySelector('meta[name="keywords"]');
          if (metaKeywords) {
            data.metadata.keywords = metaKeywords.getAttribute("content") || "";
          }

          document
            .querySelectorAll("h1, h2, h3, h4, h5, h6")
            .forEach((heading) => {
              data.headings.push({
                level: parseInt(heading.tagName.charAt(1)),
                text: heading.textContent.trim(),
                id: heading.id || null,
              });
            });

          const contentSelectors = [
            "p",
            "div.content",
            ".main-content",
            ".page-content",
            ".article-content",
            ".description",
            ".info",
            ".details",
            ".summary",
            "article",
            "section",
            ".text-content",
          ];

          contentSelectors.forEach((selector) => {
            document.querySelectorAll(selector).forEach((element) => {
              const text = element.textContent.trim();
              if (
                text &&
                text.length > 30 &&
                !data.content.some((existing) =>
                  existing.includes(text.substring(0, 50))
                )
              ) {
                data.content.push(text);
              }
            });
          });

          document.querySelectorAll("table").forEach((table) => {
            const tableData = [];
            table.querySelectorAll("tr").forEach((row) => {
              const rowData = [];
              row.querySelectorAll("td, th").forEach((cell) => {
                rowData.push(cell.textContent.trim());
              });
              if (rowData.length > 0) tableData.push(rowData);
            });
            if (tableData.length > 0) data.tables.push(tableData);
          });

          document.querySelectorAll("ul, ol").forEach((list) => {
            const listItems = [];
            list.querySelectorAll("li").forEach((item) => {
              const text = item.textContent.trim();
              if (text && text.length > 10) listItems.push(text);
            });
            if (listItems.length > 0) data.lists.push(listItems);
          });

          document.querySelectorAll("a[href]").forEach((link) => {
            const href = link.getAttribute("href");
            const text = link.textContent.trim();
            if (href) {
              data.links.push({
                href: href,
                text: text || href,
                title: link.getAttribute("title") || "",
                className: link.className || "",
                parentText: link.parentElement
                  ? link.parentElement.textContent.trim().substring(0, 100)
                  : "",
              });
            }
          });

          return data;
        });
      };

      const normalizeDomData = (data) => {
        const source = data && typeof data === "object" ? data : {};
        const metadata =
          source.metadata && typeof source.metadata === "object"
            ? source.metadata
            : {};
        return {
          title: source.title || "",
          headings: Array.isArray(source.headings) ? source.headings : [],
          content: Array.isArray(source.content) ? source.content : [],
          links: Array.isArray(source.links) ? source.links : [],
          metadata: {
            description: metadata.description || "",
            keywords: metadata.keywords || "",
          },
          tables: Array.isArray(source.tables) ? source.tables : [],
          lists: Array.isArray(source.lists) ? source.lists : [],
        };
      };

      // Try to load more content by scrolling
      await this.page.evaluate(() => {
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

      let rawPageData = null;
      try {
        rawPageData = await extractFullDom();
      } catch {
        rawPageData = null;
      }

      const pageData = normalizeDomData(rawPageData);

      pageMeta.title = pageData.title || pageMeta.title;
      const finalPageTitle = pageMeta.title;
      if (finalPageTitle) {
        this.scrapedData.links.pdf.forEach((link) => {
          if (link.sourceUrl === url) {
            link.sourceTitle = finalPageTitle;
          }
        });
        this.scrapedData.documents.pdfs.forEach((pdf) => {
          if (pdf.parentPageUrl === url) {
            pdf.parentPageTitle = finalPageTitle;
            if (Object.prototype.hasOwnProperty.call(pdf, "sourceTitle")) {
              pdf.sourceTitle = finalPageTitle;
            }
          }
        });
      }

      const currentSourceTitle = pageMeta.title;
      const extractedTables = Array.isArray(pageData.tables)
        ? pageData.tables
        : [];
      const tableTextContent = (() => {
        if (!Array.isArray(extractedTables)) return [];
        const lines = [];
        extractedTables.forEach((table) => {
          if (!table) return;
          if (Array.isArray(table)) {
            table.forEach((row) => {
              if (Array.isArray(row)) {
                lines.push(row.join(" "));
              } else if (row) {
                lines.push(String(row));
              }
            });
            return;
          }
          if (typeof table === "object") {
            if (Array.isArray(table.headers) && table.headers.length) {
              lines.push(table.headers.join(" "));
            }
            if (Array.isArray(table.rows)) {
              table.rows.forEach((row) => {
                if (Array.isArray(row)) {
                  lines.push(row.join(" "));
                } else if (row) {
                  lines.push(String(row));
                }
              });
            }
          }
        });
        return lines;
      })();

      const cleanedLinks = [];
      const seenLinks = new Set();
      pageData.links.forEach((link) => {
        const rawHref = (link.href || "").trim();
        if (!rawHref) return;
        const lowerHref = rawHref.toLowerCase();
        if (
          lowerHref.startsWith("javascript:") ||
          lowerHref.startsWith("mailto:") ||
          lowerHref.startsWith("tel:")
        )
          return;
        if (rawHref === "#") return;

        let absoluteHref;
        try {
          absoluteHref = new URL(rawHref, url).href;
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
      pageData.links = cleanedLinks;

      const allContent = [
        pageData.title,
        ...pageData.headings.map((h) => h.text),
        ...pageData.content,
        ...tableTextContent,
        ...pageData.lists.flat(),
        pageData.metadata.description,
        pageData.metadata.keywords,
      ]
        .filter(Boolean)
        .join(" ");

      const cacheKey = this.normalizeForComparison(url) || url;
      const resolvedUrl = this.page.url();
      const resolvedKey =
        this.normalizeForComparison(resolvedUrl) || resolvedUrl;
      latestResolvedKey = resolvedKey;
      const xhrEntries = [];
      const seenXhr = new Set();
      const collectXhrFromKey = (key) => {
        if (!key) return;
        const bucket = this.pageXHRCache.get(key);
        if (!bucket || !Array.isArray(bucket)) return;
        bucket.forEach((entry) => {
          if (!entry || typeof entry !== "object") return;
          const signature = `${entry.url || ""}|${entry.timestamp || ""}`;
          if (seenXhr.has(signature)) return;
          seenXhr.add(signature);
          xhrEntries.push(entry);
        });
      };
      collectXhrFromKey(cacheKey);
      if (resolvedKey && resolvedKey !== cacheKey) {
        collectXhrFromKey(resolvedKey);
      }
      this.pageXHRCache.set(cacheKey, xhrEntries);
      if (resolvedKey && resolvedKey !== cacheKey) {
        this.pageXHRCache.set(resolvedKey, xhrEntries);
      }

      const processedPage = {
        url: url,
        timestamp: new Date().toISOString(),
        depth: depth,
        title: pageData.title,
        headings: pageData.headings,
        content: allContent,
        rawContent: pageData.content,
        tables: extractedTables,
        lists: pageData.lists,
        metadata: pageData.metadata,
        xhrResponses: xhrEntries,
        category: this.categorizeUrl(url, allContent),
        wordCount: allContent.split(" ").length,
      };

      this.scrapedData.pages.push(processedPage);
      console.log(
        `Page ${processedPage.url} -> ${processedPage.xhrResponses.length} XHR responses captured`
      );

      pageData.links.forEach((link) => {
        try {
          const fullUrl = link.href;
          const hrefLower = fullUrl.toLowerCase();
          const linkData = {
            url: fullUrl,
            text: link.text,
            title: link.title,
            sourceUrl: url,
            sourceTitle: currentSourceTitle,
            context: link.parentText,
          };

          if (hrefLower.includes(".pdf")) {
            // NEW: apply same policy to DOM-found tender/notice PDFs
            const specialCat = this.specialPdfCategory(fullUrl);
            if (specialCat === "tender" || specialCat === "notices") {
              const allowed = this.isPdfAllowedByPolicy(fullUrl, specialCat);
              if (!allowed) {
                // too old → skip
                return;
              }
            }

            if (
              !this.scrapedData.links.pdf.some(
                (existing) =>
                  existing.url === fullUrl && existing.sourceUrl === url
              )
            ) {
              this.scrapedData.links.pdf.push(linkData);
            }
            const normalizedPdfUrl = fullUrl
              .split("#")[0]
              .split("?")[0]
              .toLowerCase();
            const before = this.pdfUrls.size;
            this.pdfUrls.add(normalizedPdfUrl);
            if (!this.pdfUrlOriginals.has(normalizedPdfUrl)) {
              this.pdfUrlOriginals.set(normalizedPdfUrl, fullUrl);
            }
            const after = this.pdfUrls.size;
            if (after > before) {
              console.log(
                `[pdf-added] ${normalizedPdfUrl}  (source: ${url})  totalUniquePDFs=${after}`
              );
            }
          } else if (hrefLower.match(/\.(jpg|jpeg|png|gif|webp)$/)) {
            this.scrapedData.links.image.push(linkData);
          } else if (fullUrl.includes("nitjsr.ac.in")) {
            this.scrapedData.links.internal.push(linkData);
            const childVisitKey = this.normalizeForComparison(fullUrl);
            if (
              childVisitKey &&
              this.isValidUrl(fullUrl) &&
              !this.visited.has(childVisitKey) &&
              !this.isExcluded(fullUrl)
            ) {
              this.toVisit.add({ url: fullUrl, depth: depth + 1 });
            }
          } else {
            this.scrapedData.links.external.push(linkData);
          }
        } catch {
          // Invalid URL, skip
        }
      });

      const pdfCountFromThisPage = this.scrapedData.links.pdf
        ? this.scrapedData.links.pdf.filter((link) => link.sourceUrl === url)
            .length
        : 0;
      const internalLinksFromThisPage = this.scrapedData.links.internal
        ? this.scrapedData.links.internal.filter(
            (link) => link.sourceUrl === url
          ).length
        : 0;
      const externalLinksFromThisPage = this.scrapedData.links.external
        ? this.scrapedData.links.external.filter(
            (link) => link.sourceUrl === url
          ).length
        : 0;

        // 👇 new: remember this page’s pdf count
        this.scrapedData.pagePdfRanking.push({
        url,
        title: pageMeta.title || pageData?.title || '',
        pdfCount: pdfCountFromThisPage
        });

      console.log(`[page-summary] ${url}
        PDFs found here: ${pdfCountFromThisPage}
        internal links: ${internalLinksFromThisPage}
        external links: ${externalLinksFromThisPage}
        total PDFs so far: ${this.scrapedData.documents.pdfs.length}
      `);

      console.log(
        `✅ Scraped: ${pageData.title} (${
          allContent.split(" ").length
        } words, ${pageData.links.length} links)`
      );
      return processedPage;
    } catch (error) {
      console.error(`❌ Failed to scrape ${url}:`, error.message);
      // if the page/session died, recreate so the *next* URL won't also fail
        if (
            error.message &&
            (error.message.includes("Target closed") ||
            error.message.includes("Session closed"))
        ) {
            try {
            await this.ensurePage();
            } catch (e) {
            console.warn("⚠️ Failed to recreate page after crash:", e.message);
            }
        }
      return null;
    } finally {
      if (detachXHR) {
        detachXHR();
      }
      const cleanupKey = this.normalizeForComparison(url) || url;
      if (cleanupKey) {
        this.pageXHRCache.delete(cleanupKey);
      }
      if (latestResolvedKey && latestResolvedKey !== cleanupKey) {
        this.pageXHRCache.delete(latestResolvedKey);
      }
    }
  }

  // fast text extractor (your old behavior, just wrapped)
  async extractPdfText(buffer, pdfUrl = "") {
    let text = "";
    let pages = 0;
    try {
      const parsed = await pdfParse(buffer);
      text = parsed.text || "";
      pages = parsed.numpages || 0;
    } catch (e) {
      console.error(`⚠️ pdf-parse failed for ${pdfUrl}:`, e.message);
    }

    // if text is tiny, assume it's scanned
    const needsOCR = !text || text.trim().length < 40;
    return { text, pages, needsOCR };
  }

  // OCR using local CLI tools: pdftoppm + tesseract
  async ocrPdfBuffer(buffer, pdfUrl = "") {
    // we'll write temp files next to this script
    const tmpBase = path.join(
      __dirname,
      `tmp_ocr_${Date.now()}_${Math.random().toString(16).slice(2)}`
    );
    const pdfPath = `${tmpBase}.pdf`;
    const imgPath = `${tmpBase}-1.png`; // pdftoppm will output this with -singlefile
    const txtPath = `${tmpBase}.txt`;

    try {
      // 1) write pdf to disk
      await fs.writeFile(pdfPath, buffer);

      // 2) convert first page to png
      // -f 1 -l 1 → only first page
      // -singlefile → name ends with -1
      await exec(`pdftoppm -f 1 -l 1 -png "${pdfPath}" "${tmpBase}"`);

      // 3) run tesseract on that image
      await exec(`tesseract "${imgPath}" "${tmpBase}" -l eng`);

      // 4) read the text back
      const ocrText = await fs.readFile(txtPath, "utf8");
      return ocrText.trim();
    } catch (err) {
      console.error(`❌ Local OCR failed for ${pdfUrl}:`, err.message);
      return "";
    } finally {
      // best-effort cleanup – remove everything that could have been created
      const extraCandidates = [
        pdfPath,
        imgPath,
        txtPath,
        `${tmpBase}.log`, // some tesseract builds drop a log
        `${tmpBase}.html`, // rare, but keep it safe
        `${tmpBase}.hocr`,
        `${tmpBase}.tsv`,
        `${tmpBase}-1.ppm`, // in case pdftoppm wrote ppm
        `${tmpBase}.png`, // safety, if any tool wrote plain png
      ];

      for (const f of extraCandidates) {
        try {
          await fs.unlink(f);
        } catch {}
      }

      // Additional cleanup for files generated with the same tmp base (covers -01.png, .ppm, etc.)
      try {
        const tmpPrefix = path.basename(tmpBase);
        const entries = await fs.readdir(__dirname);
        for (const entry of entries) {
          if (entry.startsWith(tmpPrefix)) {
            const fullPath = path.join(__dirname, entry);
            try {
              await fs.unlink(fullPath);
            } catch {}
          }
        }
      } catch {}
    }
  }

  async processPDFDocuments() {
    console.log(
      `🗂️ Processing ${this.pdfUrls.size} discovered PDF documents...`
    );

    const pdfArray = Array.from(this.pdfUrls);
    const maxPdfs = pdfArray.length;

    for (let i = 0; i < maxPdfs; i++) {
      const pdfKey = pdfArray[i];
      const pdfUrl = this.pdfUrlOriginals.get(pdfKey) || pdfKey;
      try {
        console.log(`📄 Processing PDF ${i + 1}/${maxPdfs}: ${pdfUrl}`);

        let pdfText = "";
        let pdfPages = 0;
        let pdfBuffer = null;

        // 1) download pdf
        try {
          const response = await axios.get(pdfUrl, {
            responseType: "arraybuffer",
            timeout: 60000,
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
            maxContentLength: 50 * 1024 * 1024,
          });
          pdfBuffer = Buffer.from(response.data);
        } catch (downloadError) {
          console.error(
            `❌ Failed to download PDF ${pdfUrl}:`,
            downloadError.message
          );
        }

        // 2) fast text parse
        let needsOCR = false;
        if (pdfBuffer) {
          const parsed = await this.extractPdfText(pdfBuffer, pdfUrl);
          pdfText = parsed.text;
          pdfPages = parsed.pages;
          needsOCR = parsed.needsOCR;
        }

        // 3) if it looked scanned → run local OCR
        if (pdfBuffer) {
          console.log(
            `🧐 ${pdfUrl} looks like scanned PDF. Running local OCR...`
          );
          const ocrText = await this.ocrPdfBuffer(pdfBuffer, pdfUrl);
          if (ocrText && ocrText.length > 0) {
            pdfText = ocrText;
          }
        }

        // 4) link info (your old logic)
        const linkInfo = this.scrapedData.links.pdf.find(
          (link) => link.url === pdfUrl
        );

        // 5) categorize
        const special = this.specialPdfCategory(pdfUrl);
        const finalCategory = special || this.categorizeUrl(pdfUrl, pdfText);

        // 6) sitemap date (keep as is)
        let publishedAt = null;
        try {
          const key = this.normalizePolicyKey(pdfUrl);
          const iso =
            key && this.sitemapPdfPolicy && this.sitemapPdfPolicy.dates
              ? this.sitemapPdfPolicy.dates.get(key)
              : null;
          if (iso) publishedAt = iso;
        } catch {}

        // 7) build final object (👉 no needsOCR!)
        const pdfDoc = {
          url: pdfUrl,
          title: linkInfo ? linkInfo.text : pdfUrl.split("/").pop(),
          text: pdfText,
          pages: pdfPages,
          category: finalCategory,
          timestamp: new Date().toISOString(),
          parentPageUrl: linkInfo ? linkInfo.sourceUrl : "",
          parentPageTitle: linkInfo ? linkInfo.sourceTitle : "",
          sourceUrl: linkInfo ? linkInfo.sourceUrl : "",
          sourceTitle: linkInfo ? linkInfo.sourceTitle : "",
          wordCount: pdfText ? pdfText.split(/\s+/).filter(Boolean).length : 0,
          publishedAt: publishedAt || null,
          publishedAtSource: publishedAt ? "sitemap" : null,
        };

        // 8) upsert
        const existingIndex = this.scrapedData.documents.pdfs.findIndex(
          (doc) => doc.url === pdfUrl
        );
        if (existingIndex !== -1) {
          this.scrapedData.documents.pdfs[existingIndex] = {
            ...this.scrapedData.documents.pdfs[existingIndex],
            ...pdfDoc,
          };
        } else {
          this.scrapedData.documents.pdfs.push(pdfDoc);
        }

        console.log(
          `✅ Processed PDF: ${pdfDoc.pages} pages, ${pdfDoc.wordCount} words`
        );
      } catch (error) {
        console.error(`❌ Failed to process PDF ${pdfUrl}:`, error.message);
      }
    }
  }

  async scrapeComprehensive(runOptions = {}) {
    let restoreOptions = null;

    try {
      await this.initialize();

      restoreOptions = this.applyRuntimeOptions(runOptions);

      this.priorityQueue = [];

      const prioritySeen = new Set();

      this.priorityUrls.forEach((priorityUrl) => {
        try {
          const fullUrl = this.normalizeUrl(priorityUrl);

          if (!fullUrl) return;

          if (this.isExcluded(fullUrl)) return;

          if (!this.isValidUrl(fullUrl)) return;

          const priorityKey = this.normalizeForComparison(fullUrl) || fullUrl;

          if (prioritySeen.has(priorityKey) || this.visited.has(priorityKey))
            return;

          prioritySeen.add(priorityKey);

          const entry = { url: fullUrl, depth: 0 };

          this.priorityQueue.push(entry);

          this.toVisit.add(entry);
        } catch {
          // ignore invalid priority URL
        }
      });

      const startUrls = ["https://nitjsr.ac.in/"];

      // Add starting URLs to visit queue

      startUrls.forEach((url) => {
        const normalized = this.normalizeUrl(url);

        if (!normalized) return;

        if (this.isExcluded(normalized)) return;

        const startKey = this.normalizeForComparison(normalized);

        if (startKey && this.visited.has(startKey)) return;

        this.toVisit.add({ url: normalized, depth: 0 });
      });

      // --- NEW: seed queue from sitemap(s) ---

      await this.loadSitemapUrls();

      // --- END NEW ---

      console.log(
        `?? Starting enhanced comprehensive scrape of ${startUrls.length} main sections...`
      );

      while (
        (this.priorityQueue.length > 0 || this.toVisit.size > 0) &&
        this.visited.size < this.maxPages
      ) {
        let nextEntry = null;

        if (this.priorityQueue.length > 0) {
          nextEntry = this.priorityQueue.shift();

          for (const candidate of this.toVisit) {
            if (candidate.url === nextEntry.url) {
              this.toVisit.delete(candidate);

              break;
            }
          }
        } else {
          const iterator = this.toVisit.values().next();

          if (iterator.done) break;

          nextEntry = iterator.value;

          this.toVisit.delete(nextEntry);
        }

        if (!nextEntry) continue;

        const { url, depth } = nextEntry;

        if (this.isExcluded(url)) {
          continue;
        }

        await this.scrapePage(url, depth);

        if (this.visited.size % 20 === 0) {
          console.log(
            `?? Progress: ${this.visited.size}/${this.maxPages} pages scraped, ${this.pdfUrls.size} PDFs found`
          );
        }
      }

    //   await this.processPDFDocuments();

      this.updateStatistics();

      const result = await this.saveData();

      return result;
    } catch (error) {
      console.error(
        "?? Enhanced comprehensive scraping failed:",
        error.message
      );

      throw error;
    } finally {
      if (typeof restoreOptions === "function") {
        try {
          restoreOptions();
        } catch (restoreError) {
          console.warn(
            "??  Failed to restore scraper options:",
            restoreError?.message || restoreError
          );
        }
      }

      await this.cleanup();
    }
  }

  updateStatistics() {
    this.scrapedData.statistics.totalPages = this.scrapedData.pages.length;
    this.scrapedData.statistics.totalPDFs =
      this.scrapedData.documents.pdfs.length;
    this.scrapedData.statistics.totalLinks =
      this.scrapedData.links.internal.length +
      this.scrapedData.links.external.length +
      this.scrapedData.links.pdf.length +
      this.scrapedData.links.image.length;
    this.scrapedData.statistics.categorizedPages =
      this.scrapedData.pages.length;

      // 👇 new: sort by pdfCount desc
    if (Array.isArray(this.scrapedData.pagePdfRanking)) {
        this.scrapedData.pagePdfRanking.sort((a, b) => b.pdfCount - a.pdfCount);
    }
  }

  async saveData() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "_");
    const filename = `nitjsr_enhanced_comprehensive_${timestamp}.json`;
    const filepath = path.join(__dirname, "scraped_data", filename);

    // Ensure directory exists
    await fs.mkdir(path.dirname(filepath), { recursive: true });

    // Save the data
    await fs.writeFile(
      filepath,
      JSON.stringify(this.scrapedData, null, 2),
      "utf8"
    );

    const categoryCounts = this.scrapedData.pages.reduce((acc, page) => {
      const key = page.category || "general";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    const summary = {
      filename: filename,
      timestamp: new Date().toISOString(),
      totalPages: this.scrapedData.statistics.totalPages,
      totalPDFs: this.scrapedData.statistics.totalPDFs,
      totalLinks: this.scrapedData.statistics.totalLinks,
      categories: Object.entries(categoryCounts).map(([name, count]) => ({
        name,
        count,
      })),
      pdfBreakdown: this.scrapedData.documents.pdfs.map((pdf) => ({
        title: pdf.title,
        pages: pdf.pages,
        wordCount: pdf.wordCount,
        category: pdf.category,
      })),
      filepath: filepath,
    };

    console.log(`💾 Data saved to: ${filepath}`);
    console.log(
      `📊 Summary: ${summary.totalPages} pages, ${summary.totalPDFs} PDFs, ${summary.totalLinks} links`
    );

    return { summary, filepath, data: this.scrapedData };
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      console.log("🧹 Browser cleanup completed");
    }
  }
}

export { NITJSRScraper };
