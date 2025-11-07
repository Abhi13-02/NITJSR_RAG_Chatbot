import fs from "fs/promises";
import path from "path";
import axios from "axios";
import pdfParse from "pdf-parse";
import { exec as _exec } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";

import { NITJSRScraper } from "./scraper.js";

const exec = promisify(_exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const SCRAPED_DATA_DIR = path.join(ROOT_DIR, "scraped_data");
const DEFAULT_BASE_URL = "https://nitjsr.ac.in";

const normalizePdfKey = (url = "") => {
  if (typeof url !== "string" || !url.trim()) return null;
  return url.split("#")[0].split("?")[0].trim().toLowerCase();
};

async function resolveTargetFile(cliPath) {
  if (cliPath) {
    const absolute = path.isAbsolute(cliPath)
      ? cliPath
      : path.resolve(ROOT_DIR, cliPath);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) {
      throw new Error(`Provided path is not a file: ${absolute}`);
    }
    return absolute;
  }

  await fs.mkdir(SCRAPED_DATA_DIR, { recursive: true });
  const entries = await fs.readdir(SCRAPED_DATA_DIR);
  const jsonFiles = entries
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .sort();

  if (!jsonFiles.length) {
    throw new Error(
      `No JSON snapshots found inside ${SCRAPED_DATA_DIR}. Run the scraper first.`
    );
  }

  return path.join(SCRAPED_DATA_DIR, jsonFiles[jsonFiles.length - 1]);
}

async function loadScrapedJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const data = JSON.parse(raw);

  if (!data.documents || typeof data.documents !== "object") {
    data.documents = {};
  }
  if (!Array.isArray(data.documents.pdfs)) {
    data.documents.pdfs = [];
  }

  if (!data.links || typeof data.links !== "object") {
    data.links = {};
  }
  if (!Array.isArray(data.links.pdf)) {
    data.links.pdf = [];
  }

  if (!data.statistics || typeof data.statistics !== "object") {
    data.statistics = {};
  }

  return data;
}

function collectPdfCandidates(scrapedData) {
  const candidates = new Map();

  const remember = (url, extra) => {
    const key = normalizePdfKey(url);
    if (!key) return;

    if (!candidates.has(key)) {
      candidates.set(key, {
        key,
        url,
        linkInfo: null,
        existingDoc: null,
      });
    }

    const entry = candidates.get(key);
    if (!entry.url && url) entry.url = url;
    if (extra.linkInfo && !entry.linkInfo) entry.linkInfo = extra.linkInfo;
    if (extra.existingDoc && !entry.existingDoc)
      entry.existingDoc = extra.existingDoc;
  };

  if (Array.isArray(scrapedData.documents?.pdfs)) {
    for (const doc of scrapedData.documents.pdfs) {
      if (doc?.url) {
        remember(doc.url, { existingDoc: doc });
      }
    }
  }

  return Array.from(candidates.values()).filter((entry) => !!entry.url);
}

async function downloadPdfBuffer(pdfUrl) {
  const response = await axios.get(pdfUrl, {
    responseType: "arraybuffer",
    timeout: 60000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    maxContentLength: 50 * 1024 * 1024,
  });
  return Buffer.from(response.data);
}

async function extractPdfText(buffer, pdfUrl = "") {
  let text = "";
  let pages = 0;
  try {
    const parsed = await pdfParse(buffer);
    text = parsed.text || "";
    pages = parsed.numpages || 0;
  } catch (error) {
    console.error(`[pdf] pdf-parse failed for ${pdfUrl}: ${error.message}`);
  }

  const needsOCR = !text || text.trim().length < 40;
  return { text, pages, needsOCR };
}

async function ocrPdfBuffer(buffer, pdfUrl = "") {
  const tmpBase = path.join(
    __dirname,
    `tmp_ocr_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const pdfPath = `${tmpBase}.pdf`;
  const imgPath = `${tmpBase}-1.png`;
  const txtPath = `${tmpBase}.txt`;

  try {
    await fs.writeFile(pdfPath, buffer);
    await exec(`pdftoppm -f 1 -l 1 -png "${pdfPath}" "${tmpBase}"`);
    await exec(`tesseract "${imgPath}" "${tmpBase}" -l eng`);
    const ocrText = await fs.readFile(txtPath, "utf8");
    return ocrText.trim();
  } catch (error) {
    console.error(`[pdf] Local OCR failed for ${pdfUrl}: ${error.message}`);
    return "";
  } finally {
    const extraCandidates = [
      pdfPath,
      imgPath,
      txtPath,
      `${tmpBase}.log`,
      `${tmpBase}.html`,
      `${tmpBase}.hocr`,
      `${tmpBase}.tsv`,
      `${tmpBase}-1.ppm`,
      `${tmpBase}.png`,
    ];

    for (const candidate of extraCandidates) {
      try {
        await fs.unlink(candidate);
      } catch {
        // best effort
      }
    }

    try {
      const tmpPrefix = path.basename(tmpBase);
      const entries = await fs.readdir(__dirname);
      for (const entry of entries) {
        if (entry.startsWith(tmpPrefix)) {
          const fullPath = path.join(__dirname, entry);
          try {
            await fs.unlink(fullPath);
          } catch {
            // best effort
          }
        }
      }
    } catch {
      // ignore cleanup errors
    }
  }
}

function buildPdfDoc(helper, pdfUrl, pdfText, pdfPages, existingDoc, linkInfo) {
  const timestamp = new Date().toISOString();
  const special = helper.specialPdfCategory(pdfUrl);
  const finalCategory =
    existingDoc?.category ||
    special ||
    helper.categorizeUrl(pdfUrl, pdfText || existingDoc?.text || "");

  const titleCandidates = [
    existingDoc?.title,
    linkInfo?.text,
    linkInfo?.title,
    pdfUrl?.split("/").pop(),
    pdfUrl,
  ];
  const title =
    titleCandidates.find(
      (value) => typeof value === "string" && value.trim().length > 0
    ) || pdfUrl;

  let publishedAt = existingDoc?.publishedAt || null;
  let publishedAtSource = existingDoc?.publishedAtSource || null;
  if (!publishedAt) {
    try {
      const key = helper.normalizePolicyKey(pdfUrl);
      const iso =
        key && helper.sitemapPdfPolicy && helper.sitemapPdfPolicy.dates
          ? helper.sitemapPdfPolicy.dates.get(key)
          : null;
      if (iso) {
        publishedAt = iso;
        publishedAtSource = "sitemap";
      }
    } catch {
      // ignore lookup errors
    }
  }

  const finalText = pdfText || existingDoc?.text || "";
  const wordCount = finalText
    ? finalText.split(/\s+/).filter(Boolean).length
    : existingDoc?.wordCount || 0;

  return {
    url: pdfUrl,
    title: title.trim(),
    text: finalText,
    pages: pdfPages || existingDoc?.pages || 0,
    category: finalCategory || "general",
    timestamp,
    parentPageUrl: linkInfo?.sourceUrl || existingDoc?.parentPageUrl || "",
    parentPageTitle:
      linkInfo?.sourceTitle || existingDoc?.parentPageTitle || "",
    sourceUrl: linkInfo?.sourceUrl || existingDoc?.sourceUrl || "",
    sourceTitle: linkInfo?.sourceTitle || existingDoc?.sourceTitle || "",
    wordCount,
    publishedAt: publishedAt || null,
    publishedAtSource: publishedAtSource || null,
  };
}

function upsertPdfDoc(scrapedData, pdfDoc) {
  const docs = scrapedData.documents.pdfs;
  const existingIndex = docs.findIndex((doc) => doc.url === pdfDoc.url);

  if (existingIndex !== -1) {
    const existing = docs[existingIndex];
    docs[existingIndex] = {
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
    return docs[existingIndex];
  }

  docs.push(pdfDoc);
  return pdfDoc;
}

async function processPdfs(cliPath) {
  const targetFile = await resolveTargetFile(cliPath);
  console.log(`[pdf] Processing snapshots in ${targetFile}`);

  const scrapedData = await loadScrapedJson(targetFile);
  const baseUrl = scrapedData?.metadata?.baseUrl || DEFAULT_BASE_URL;

  const helper = new NITJSRScraper({
    maxPages: scrapedData?.metadata?.maxPages || 0,
    maxDepth: scrapedData?.metadata?.maxDepth || 0,
  });
  helper.baseUrl = baseUrl;

  try {
    await helper.loadSitemapUrls();
  } catch (error) {
    console.warn(
      `[pdf] Unable to refresh sitemap metadata: ${error?.message || error}`
    );
  }

  const candidates = collectPdfCandidates(scrapedData);
  if (!candidates.length) {
    console.log("[pdf] No PDF entries were found in this snapshot.");
    return;
  }

  console.log(`[pdf] Found ${candidates.length} PDF(s) to process.`);

  for (let i = 0; i < candidates.length; i++) {
    const { url: pdfUrl, existingDoc, linkInfo } = candidates[i];
    console.log(`[pdf] (${i + 1}/${candidates.length}) ${pdfUrl}`);

    let buffer = null;
    try {
      buffer = await downloadPdfBuffer(pdfUrl);
    } catch (error) {
      console.error(`[pdf] Failed to download ${pdfUrl}: ${error.message}`);
      continue;
    }

    let pdfText = "";
    let pdfPages = 0;
    if (buffer) {
      const parsed = await extractPdfText(buffer, pdfUrl);
      pdfText = parsed.text;
      pdfPages = parsed.pages;
      // keep the same behavior as before (run OCR regardless)
    }

    if (buffer) {
      console.log(`[pdf] Running OCR for ${pdfUrl}`);
      const ocrText = await ocrPdfBuffer(buffer, pdfUrl);
      if (ocrText && ocrText.length > 0) {
        pdfText = ocrText;
      }
    }

    try {
      const pdfDoc = buildPdfDoc(
        helper,
        pdfUrl,
        pdfText,
        pdfPages,
        existingDoc,
        linkInfo
      );
      const finalDoc = upsertPdfDoc(scrapedData, pdfDoc);
      console.log(
        `[pdf] Saved ${finalDoc.pages} page(s), ${finalDoc.wordCount} words`
      );
    } catch (error) {
      console.error(`[pdf] Failed to update metadata for ${pdfUrl}: ${error}`);
    }
  }

  scrapedData.statistics.totalPDFs = scrapedData.documents.pdfs.length;
  await fs.writeFile(targetFile, JSON.stringify(scrapedData, null, 2), "utf8");

  console.log(
    `[pdf] Completed. ${scrapedData.statistics.totalPDFs} PDF(s) stored in ${targetFile}`
  );
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const cliPath = process.argv[2] || null;
  processPdfs(cliPath).catch((error) => {
    console.error(`[pdf] Processing failed: ${error?.message || error}`);
    process.exit(1);
  });
}
