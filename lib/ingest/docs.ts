import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { put } from "@vercel/blob";
import mammoth from "mammoth";
import Reducto, { toFile } from "reductoai";
import {
  createEmbedding,
  type TurbopufferUpsertRow,
  upsertRowsToTurbopuffer,
} from "@/lib/rag/turbopuffer";

const MAX_CONTENT_CHARS = 3800;

function safeProjectSlug(input: string) {
  const slug = input.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  return slug.replace(/^_+|_+$/g, "") || "default";
}

function chunkText(text: string, maxLen = 2400, overlap = 200) {
  const chunks: string[] = [];
  const n = text.length;
  if (n === 0 || maxLen <= 0) {
    return chunks;
  }
  const effectiveOverlap = Math.max(0, Math.min(overlap, maxLen - 1));
  const step = maxLen - effectiveOverlap;
  let i = 0;
  while (i < n) {
    const end = Math.min(i + maxLen, n);
    const slice = text.slice(i, end).trim();
    if (slice) chunks.push(slice);
    if (end === n) break;
    i += step;
  }
  return chunks;
}

async function extractTextFromPdf(buffer: Buffer) {
  // pdfjs-dist references some browser globals (DOMMatrix/ImageData/Path2D) at module init.
  // We only do text extraction (no rendering), so lightweight stubs are sufficient in Node.
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined") {
    g.DOMMatrix = class DOMMatrix {
      // Intentionally empty stub for server-side text extraction.
      // eslint-disable-next-line @typescript-eslint/no-useless-constructor
      constructor() {}
    };
  }
  if (typeof g.ImageData === "undefined") {
    g.ImageData = class ImageData {
      // eslint-disable-next-line @typescript-eslint/no-useless-constructor
      constructor() {}
    };
  }
  if (typeof g.Path2D === "undefined") {
    g.Path2D = class Path2D {
      // eslint-disable-next-line @typescript-eslint/no-useless-constructor
      constructor() {}
    };
  }

  try {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as any;
    // Point pdf.js at the worker file on disk (helps in some Next environments).
    try {
      const workerFsPath = path.join(
        process.cwd(),
        "node_modules",
        "pdfjs-dist",
        "legacy",
        "build",
        "pdf.worker.mjs"
      );
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerFsPath).toString();
    } catch {
      // Best-effort
    }

    const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const loadingTask = pdfjs.getDocument({ data, disableWorker: true });
    const doc = await loadingTask.promise;

    const pageNumbers = Array.from({ length: doc.numPages }, (_, i) => i + 1);
    const pageTexts = await Promise.all(
      pageNumbers.map(async (pageNumber) => {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        const items: Array<{ str?: unknown }> = Array.isArray(content?.items)
          ? content.items
          : [];
        return items
          .map((item) => (typeof item.str === "string" ? item.str : ""))
          .join(" ");
      })
    );

    return pageTexts.join("\n").trim();
  } catch {
    const pdfParseModule = (await import("pdf-parse")) as unknown as {
      default?: unknown;
    };
    const pdfParse = (pdfParseModule.default ?? pdfParseModule) as (input: Buffer) => Promise<{
      text?: unknown;
    }>;
    const parsed = await pdfParse(buffer);
    return (typeof parsed.text === "string" ? parsed.text : "").trim();
  }
}

async function extractPagesWithReducto(
  buffer: Buffer,
  filename: string
): Promise<string[]> {
  const apiKey = process.env.REDUCTO_API_KEY ?? process.env.REDUCTO_KEY;
  if (!apiKey) {
    throw new Error("No Reducto API key configured");
  }

  const client = new Reducto({ apiKey });
  const uploadFile = await toFile(buffer, filename, { type: "application/pdf" });
  const upload = await client.upload({ file: uploadFile });

  const response = await client.parse.run({ input: upload });

  // Handle async vs sync response
  if (!("result" in response)) {
    throw new Error("Reducto parse returned an async job; expected a synchronous result.");
  }

  // Reducto parse returns chunks with markdown content
  const { result } = response;
  const resultObj = result as { chunks?: Array<{ content?: string }> };
  if (!resultObj || !Array.isArray(resultObj.chunks)) {
    throw new Error("Reducto parse returned no chunks");
  }

  const pages = resultObj.chunks
    .map((chunk) =>
      typeof chunk.content === "string" ? chunk.content.trim() : ""
    )
    .filter((text) => text.length > 0);

  if (pages.length === 0) {
    throw new Error("Reducto parse returned empty content");
  }

  return pages;
}

async function extractPagesWithPdfjs(buffer: Buffer): Promise<string[]> {
  // Fallback: pdfjs-based extraction when Reducto is unavailable.
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined") {
    g.DOMMatrix = class DOMMatrix {
      // eslint-disable-next-line @typescript-eslint/no-useless-constructor
      constructor() {}
    };
  }
  if (typeof g.ImageData === "undefined") {
    g.ImageData = class ImageData {
      // eslint-disable-next-line @typescript-eslint/no-useless-constructor
      constructor() {}
    };
  }
  if (typeof g.Path2D === "undefined") {
    g.Path2D = class Path2D {
      // eslint-disable-next-line @typescript-eslint/no-useless-constructor
      constructor() {}
    };
  }

  try {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as any;
    try {
      const workerFsPath = path.join(
        process.cwd(),
        "node_modules",
        "pdfjs-dist",
        "legacy",
        "build",
        "pdf.worker.mjs"
      );
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerFsPath).toString();
    } catch {
      // Best-effort
    }

    const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const loadingTask = pdfjs.getDocument({ data, disableWorker: true });
    const doc = await loadingTask.promise;

    const pageNumbers = Array.from({ length: doc.numPages }, (_, i) => i + 1);
    const pageTexts = await Promise.all(
      pageNumbers.map(async (pageNumber) => {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        const items: Array<{ str?: unknown }> = Array.isArray(content?.items)
          ? content.items
          : [];
        return items
          .map((item) => (typeof item.str === "string" ? item.str : ""))
          .join(" ")
          .trim();
      })
    );

    return pageTexts.filter((t) => t.length > 0);
  } catch {
    const pdfParseModule = (await import("pdf-parse")) as unknown as {
      default?: unknown;
    };
    const pdfParse = (pdfParseModule.default ?? pdfParseModule) as (input: Buffer) => Promise<{
      text?: unknown;
    }>;
    const parsed = await pdfParse(buffer);
    const text = (typeof parsed.text === "string" ? parsed.text : "").trim();
    return text ? [text] : [];
  }
}

async function extractPagesFromPdf(
  buffer: Buffer,
  filename?: string
): Promise<string[]> {
  // Try Reducto first for better OCR and form field extraction
  try {
    return await extractPagesWithReducto(buffer, filename ?? "document.pdf");
  } catch {
    // Fall back to pdfjs when Reducto is unavailable or fails
    return await extractPagesWithPdfjs(buffer);
  }
}

async function extractTextFromDocx(buffer: Buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return (result.value ?? "").trim();
}

export async function ingestUploadedDocToTurbopuffer({
  docId,
  projectSlug,
  projectId,
  isDefaultProject,
  createdBy,
  organizationId,
  filename,
  category,
  description,
  documentType,
  mimeType,
  blobUrl,
  sourceUrl,
  sourceCreatedAtMs,
  fileBuffer,
}: {
  docId: string;
  projectSlug: string;
  projectId: string;
  isDefaultProject?: boolean;
  createdBy: string;
  organizationId?: string | null;
  filename: string;
  category?: string | null;
  description?: string | null;
  documentType?: "general_doc" | "bank_statement" | "cc_statement" | "invoice";
  mimeType: string;
  blobUrl: string;
  sourceUrl?: string | null;
  sourceCreatedAtMs: number;
  fileBuffer: Buffer;
}) {
  // Store docs in per-project namespaces. Use the v2 docs suffix to avoid vector dimension mismatches.
  const namespace = isDefaultProject
    ? "_synergy_docsv2"
    : `_synergy_${projectId}_docsv2`;
  const indexedAtMs = Date.now();

  let fullText = "";
  let chunks: string[] = [];
  if (mimeType === "application/pdf") {
    const pages = await extractPagesFromPdf(fileBuffer, filename);
    fullText = pages.join("\n").trim();
    // Split into chunks to avoid exceeding embedding model token limits
    chunks = chunkText(fullText);
  } else if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    fullText = await extractTextFromDocx(fileBuffer);
    chunks = chunkText(fullText);
  } else {
    throw new Error(`Unsupported mimeType for ingestion: ${mimeType}`);
  }

  if (!fullText) {
    throw new Error("No extractable text found");
  }

  if (chunks.length === 0) {
    throw new Error("No chunks produced");
  }

  // Store extracted chunks to blob storage for debugging
  const baseFilename = filename.replace(/\.[^.]+$/, "");
  for (let idx = 0; idx < chunks.length; idx += 1) {
    await put(`structured/${docId}/${baseFilename}_${idx}.txt`, chunks[idx], {
      access: "public",
      contentType: "text/plain",
    });
  }

  const fileHash = crypto.createHash("sha1").update(fileBuffer).digest("hex");
  const rows: TurbopufferUpsertRow[] = [];

  const metadataLines = [
    filename ? `filename: ${filename}` : "",
    category ? `category: ${category}` : "",
    description ? `description: ${description}` : "",
  ].filter((line) => line.length > 0);
  const metadataPrefix = metadataLines.length > 0 ? `${metadataLines.join("\n")}\n\n` : "";

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const vector = await createEmbedding(`${metadataPrefix}${chunk}`);
    // Turbopuffer requires id strings < 64 bytes. Use a stable, short hash.
    const idHash = crypto
      .createHash("sha256")
      .update(`${docId}:${fileHash}:${index}`)
      .digest("hex")
      .slice(0, 40);
    const rowId = `docs_${idHash}`;
    rows.push({
      id: rowId,
      vector,
      content:
        chunk.length > MAX_CONTENT_CHARS
          ? `${chunk.slice(0, MAX_CONTENT_CHARS)}…`
          : chunk,
      sourceType: "docs",
      doc_source: sourceUrl && sourceUrl.toLowerCase().includes("sharepoint.com") ? "sharepoint" : "upload",
      source_url: sourceUrl ?? null,
      sourceCreatedAtMs,
      indexedAtMs,
      doc_id: docId,
      project_id: projectId,
      created_by: createdBy,
      organization_id: organizationId ?? null,
      filename,
      doc_category: category ?? null,
      doc_description: description ?? null,
      mime_type: mimeType,
      blob_url: blobUrl,
      document_type: documentType ?? "general_doc",
      chunk_index: index,
    });
  }

  await upsertRowsToTurbopuffer({ namespace, rows });

  return { namespace, chunks: rows.length };
}

export async function ingestDocSummaryToTurbopuffer({
  docId,
  projectId,
  isDefaultProject,
  createdBy,
  organizationId,
  filename,
  mimeType,
  blobUrl,
  sourceUrl,
  sourceCreatedAtMs,
  documentType,
  summaryText,
  metadata,
}: {
  docId: string;
  projectId: string;
  isDefaultProject?: boolean;
  createdBy: string;
  organizationId?: string | null;
  filename: string;
  mimeType: string;
  blobUrl: string;
  sourceUrl?: string | null;
  sourceCreatedAtMs: number;
  documentType: "general_doc" | "bank_statement" | "cc_statement" | "invoice";
  summaryText: string;
  metadata?: Record<string, unknown>;
}) {
  const namespace = isDefaultProject
    ? "_synergy_docsv2"
    : `_synergy_${projectId}_docsv2`;
  const indexedAtMs = Date.now();

  const content = summaryText.trim().slice(0, MAX_CONTENT_CHARS);
  if (!content) {
    throw new Error("Empty summaryText");
  }

  const vector = await createEmbedding(content);
  const idHash = crypto
    .createHash("sha256")
    .update(`summary:${docId}`)
    .digest("hex")
    .slice(0, 40);
  const rowId = `docs_summary_${idHash}`;

  const row: TurbopufferUpsertRow = {
    id: rowId,
    vector,
    content,
    sourceType: "docs",
    doc_source:
      sourceUrl && sourceUrl.toLowerCase().includes("sharepoint.com")
        ? "sharepoint"
        : "upload",
    source_url: sourceUrl ?? null,
    sourceCreatedAtMs,
    indexedAtMs,
    doc_id: docId,
    project_id: projectId,
    created_by: createdBy,
    organization_id: organizationId ?? null,
    filename,
    mime_type: mimeType,
    blob_url: blobUrl,
    document_type: documentType,
    is_summary: true,
    ...(metadata ?? {}),
  };

  await upsertRowsToTurbopuffer({ namespace, rows: [row] });
  return { namespace, rowId };
}
