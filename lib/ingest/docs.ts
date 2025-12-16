import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import mammoth from "mammoth";
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

function chunkText(text: string, maxLen = 1800, overlap = 200) {
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

  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as any;
  // Turbopack can break pdf.js's default worker resolution in Next dev/server builds.
  // Point pdf.js at the real worker file on disk to avoid ".next/.../pdf.worker.mjs" lookups.
  try {
    const workerFsPath = path.join(
      process.cwd(),
      "node_modules",
      "pdfjs-dist",
      "legacy",
      "build",
      "pdf.worker.mjs"
    );
    pdfjs.GlobalWorkerOptions.workerSrc =
      pathToFileURL(workerFsPath).toString();
  } catch {
    // Best-effort: if this fails, pdf.js may still work in environments where worker resolution is correct.
  }

  // pdfjs-dist requires Uint8Array; Buffer can trip runtime checks in some builds.
  const data = new Uint8Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength
  );
  // In Next.js dev (Turbopack), pdf.js worker bundling can fail and crash ingestion.
  // We only need text extraction, so disable the worker and run parsing in-process.
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
  mimeType,
  blobUrl,
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
  mimeType: string;
  blobUrl: string;
  sourceCreatedAtMs: number;
  fileBuffer: Buffer;
}) {
  // Store docs in per-project namespaces. Default project uses legacy namespace.
  const namespace = isDefaultProject
    ? "_synergy_docs"
    : `_synergy_${projectId}_docs`;
  const indexedAtMs = Date.now();

  let fullText = "";
  if (mimeType === "application/pdf") {
    fullText = await extractTextFromPdf(fileBuffer);
  } else if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    fullText = await extractTextFromDocx(fileBuffer);
  } else {
    throw new Error(`Unsupported mimeType for ingestion: ${mimeType}`);
  }

  if (!fullText) {
    throw new Error("No extractable text found");
  }

  const chunks = chunkText(fullText);
  if (chunks.length === 0) {
    throw new Error("No chunks produced");
  }

  const fileHash = crypto.createHash("sha1").update(fileBuffer).digest("hex");
  const rows: TurbopufferUpsertRow[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const vector = await createEmbedding(chunk);
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
      sourceCreatedAtMs,
      indexedAtMs,
      doc_id: docId,
      project_id: projectId,
      created_by: createdBy,
      organization_id: organizationId ?? null,
      filename,
      mime_type: mimeType,
      blob_url: blobUrl,
      chunk_index: index,
    });
  }

  await upsertRowsToTurbopuffer({ namespace, rows });

  return { namespace, chunks: rows.length };
}
