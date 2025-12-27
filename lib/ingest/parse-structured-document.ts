import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Papa from "papaparse";
import { put } from "@vercel/blob";
import Reducto, { toFile } from "reductoai";
import { ChatSDKError } from "@/lib/errors";
import { ingestDocSummaryToTurbopuffer } from "@/lib/ingest/docs";
import {
  getProjectByIdForUser,
  getProjectDocById,
  insertFinancialTransactions,
  insertInvoiceLineItems,
  updateProjectDoc,
  upsertInvoiceForDocument,
} from "@/lib/db/queries";

type StructuredDocType = "bank_statement" | "cc_statement" | "invoice";

export type ParseStructuredDocResult =
  | {
      ok: true;
      documentType: StructuredDocType;
      schemaId: string;
      insertedTransactions?: number;
      insertedLineItems?: number;
    }
  | {
      ok: false;
      error: string;
    };

function normalizeDescription(value: unknown): string {
  return (typeof value === "string" ? value : "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

function parseYmdDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const toYmd = (y: number, m: number, d: number) => {
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    if (y < 1900 || y > 2200) return null;
    if (m < 1 || m > 12) return null;
    if (d < 1 || d > 31) return null;
    const yyyy = String(y).padStart(4, "0");
    const mm = String(m).padStart(2, "0");
    const dd = String(d).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };

  const ymd = trimmed.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (ymd) {
    return toYmd(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  }

  const mdy = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (mdy) {
    return toYmd(Number(mdy[3]), Number(mdy[1]), Number(mdy[2]));
  }

  return null;
}

function parseDecimalString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toFixed(2);
  }
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/,/g, "");
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed)) return null;
    return parsed.toFixed(2);
  }
  return null;
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function isCsvLike({ mimeType, filename }: { mimeType: string; filename: string }) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".csv")) return true;
  return (
    mimeType === "text/csv" ||
    mimeType === "application/csv" ||
    mimeType === "application/vnd.ms-excel"
  );
}

type ParsedCsvTxn = {
  date: string; // YYYY-MM-DD
  description: string;
  amount: string; // decimal string
  currency?: string | null;
};

function normalizeHeaderKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function parseCsvTransactions({ csvText }: { csvText: string }): ParsedCsvTxn[] {
  const parsed = Papa.parse<Record<string, unknown>>(csvText, {
    header: true,
    skipEmptyLines: "greedy",
    dynamicTyping: false,
  });

  const fields = Array.isArray(parsed.meta.fields) ? parsed.meta.fields : [];
  const normFields = fields.map((f) => normalizeHeaderKey(f));

  const pickField = (candidates: string[]) => {
    const set = new Set(candidates);
    for (let i = 0; i < normFields.length; i += 1) {
      if (set.has(normFields[i])) return fields[i];
    }
    return null;
  };

  const dateField =
    pickField(["date", "txn_date", "transaction_date", "posted_date", "post_date"]) ?? null;
  const descField = pickField(["description", "desc", "memo", "details", "merchant", "name"]) ?? null;

  // Amount handling: either a single amount column OR debit/credit split
  const amountField = pickField(["amount", "signed_amount", "value", "net_amount", "total"]) ?? null;
  const debitField = pickField(["debit", "withdrawal", "withdrawals", "charge", "charges"]);
  const creditField = pickField(["credit", "deposit", "deposits", "payment", "payments"]);
  const currencyField = pickField(["currency", "ccy"]);

  if (!dateField || (!amountField && !(debitField || creditField))) {
    return [];
  }

  const rows = Array.isArray(parsed.data) ? parsed.data : [];
  const out: ParsedCsvTxn[] = [];

  for (const row of rows) {
    const rawDate = row[dateField];
    const txnDate = parseYmdDate(rawDate);
    if (!txnDate) continue;

    const desc = descField ? normalizeDescription(row[descField]) : "";
    const currency =
      currencyField && typeof row[currencyField] === "string"
        ? row[currencyField].trim().slice(0, 16)
        : null;

    let amount: string | null = null;
    if (amountField) {
      amount = parseDecimalString(row[amountField]);
    } else {
      const debit = debitField ? parseDecimalString(row[debitField]) : null;
      const credit = creditField ? parseDecimalString(row[creditField]) : null;
      if (credit && credit !== "0.00") amount = credit;
      else if (debit && debit !== "0.00") amount = (-Number(debit)).toFixed(2);
    }
    if (!amount) continue;

    out.push({
      date: txnDate,
      description: desc,
      amount,
      currency,
    });
  }

  return out;
}

async function readSchemaJson(schemaId: string): Promise<string> {
  if (!/^[a-z0-9_]+$/i.test(schemaId)) {
    throw new Error(`Invalid schemaId: ${schemaId}`);
  }

  const schemaPath = path.join(process.cwd(), "schemas", "reducto", `${schemaId}.json`);
  try {
    return await readFile(schemaPath, "utf8");
  } catch {
    throw new Error(`Missing schema file for ${schemaId}`);
  }
}

async function callReductoExtract({
  schemaId,
  schemaJson,
  fileName,
  mimeType,
  fileBuffer,
}: {
  schemaId: string;
  schemaJson: string;
  fileName: string;
  mimeType: string;
  fileBuffer: ArrayBuffer;
}): Promise<unknown> {
  const apiKey = process.env.REDUCTO_API_KEY ?? process.env.REDUCTO_KEY;
  if (!apiKey) {
    throw new Error("Missing Reducto API key. Set REDUCTO_API_KEY (or REDUCTO_KEY).");
  }

  const client = new Reducto({ apiKey });
  const uploadFile = await toFile(fileBuffer, fileName, { type: mimeType });
  const upload = await client.upload({ file: uploadFile });

  const parsedSchema =
    (() => {
      const parsed: unknown = JSON.parse(schemaJson);
      if (typeof parsed === "object" && parsed !== null && "output" in parsed) {
        return (parsed as Record<string, unknown>).output ?? parsed;
      }
      return parsed;
    })();

  const systemPrompt =
    schemaId === "invoice_v1"
      ? "Extract invoice header fields and optional line items from this invoice."
      : "Extract transactions from this statement according to the provided schema.";

  const response = await client.extract.run({
    input: upload,
    instructions: { schema: parsedSchema, system_prompt: systemPrompt },
  });

  if (!("result" in response)) {
    throw new Error("Reducto extract returned an async job; expected a synchronous result.");
  }

  const { result } = response;
  if (Array.isArray(result)) {
    const first = result.at(0);
    if (!first) {
      throw new Error("Reducto extract returned an empty result.");
    }
    return first;
  }
  if (!result) {
    throw new Error("Reducto extract returned an empty result.");
  }
  return result;
}

function isStructuredType(value: string): value is StructuredDocType {
  return value === "bank_statement" || value === "cc_statement" || value === "invoice";
}

export async function parseStructuredProjectDoc({
  docId,
  userId,
  ingestSummaryToTurbopuffer = true,
}: {
  docId: string;
  userId: string;
  ingestSummaryToTurbopuffer?: boolean;
}): Promise<ParseStructuredDocResult> {
  const doc = await getProjectDocById({ docId });
  if (!doc) return { ok: false, error: "Not found" };
  if (!isStructuredType(doc.documentType)) {
    return { ok: false, error: "This document type is not parsed by this endpoint" };
  }

  const project = await getProjectByIdForUser({ projectId: doc.projectId, userId });
  if (!project) return { ok: false, error: "Not found" };

  try {
    await updateProjectDoc({
      docId: doc.id,
      data: {
        parseStatus: "pending",
        parseError: null,
      },
    });

    const rawRes = await fetch(doc.blobUrl);
    if (!rawRes.ok) throw new Error("Failed to download raw file");
    const rawBuffer = await rawRes.arrayBuffer();

    const isCsv = isCsvLike({ mimeType: doc.mimeType, filename: doc.filename });
    const schemaVersion = 1;

    const reductoSchemaId =
      doc.documentType === "bank_statement"
        ? "bank_statement_v1"
        : doc.documentType === "cc_statement"
          ? "cc_statement_v1"
          : "invoice_v1";

    let schemaId: string;
    let extracted: unknown;

    if (isCsv) {
      if (doc.documentType !== "bank_statement" && doc.documentType !== "cc_statement") {
        throw new Error("CSV parsing is only supported for bank/cc statements right now");
      }

      try {
        const schemaJson = await readSchemaJson(reductoSchemaId);
        schemaId = reductoSchemaId;
        extracted = await callReductoExtract({
          schemaId,
          schemaJson,
          fileName: doc.filename,
          mimeType: doc.mimeType,
          fileBuffer: rawBuffer,
        });
        const obj = extracted as Record<string, unknown>;
        const txns = Array.isArray(obj.transactions) ? obj.transactions : [];
        if (txns.length === 0) {
          throw new Error("Reducto returned no transactions; falling back to CSV parsing.");
        }
      } catch (_error) {
        schemaId =
          doc.documentType === "bank_statement"
            ? "bank_statement_csv_fallback_v1"
            : "cc_statement_csv_fallback_v1";
        const csvText = new TextDecoder().decode(rawBuffer);
        const transactions = parseCsvTransactions({ csvText });
        if (transactions.length === 0) {
          throw new Error("Could not parse any transactions from CSV (expected date + amount columns)");
        }
        extracted = { transactions };
      }
    } else {
      schemaId = reductoSchemaId;
      const schemaJson = await readSchemaJson(schemaId);
      extracted = await callReductoExtract({
        schemaId,
        schemaJson,
        fileName: doc.filename,
        mimeType: doc.mimeType,
        fileBuffer: rawBuffer,
      });
      if (doc.documentType === "bank_statement" || doc.documentType === "cc_statement") {
        const obj = extracted as Record<string, unknown>;
        const txns = Array.isArray(obj.transactions) ? obj.transactions : [];
        if (txns.length === 0) {
          throw new Error("Reducto returned no transactions.");
        }
      }
    }

    const extractedJson = JSON.stringify(extracted);
    const extractedBlob = await put(`extracted/${doc.id}/extracted.json`, extractedJson, {
      access: "public",
      contentType: "application/json",
    });

    let insertedTransactions = 0;
    let insertedLineItems = 0;

    if (doc.documentType === "bank_statement" || doc.documentType === "cc_statement") {
      const obj = extracted as Record<string, unknown>;
      const txns = Array.isArray(obj.transactions) ? obj.transactions : [];

      const normalizedRows = txns
        .map((t) => (t && typeof t === "object" ? (t as Record<string, unknown>) : null))
        .filter((t): t is Record<string, unknown> => t !== null)
        .map((t, idx) => {
          const txnDate = parseYmdDate(t.date);
          const amount = parseDecimalString(t.amount);
          if (!txnDate || !amount) return null;
          const description = normalizeDescription(t.description);
          const currency = typeof t.currency === "string" ? t.currency.trim().slice(0, 16) : null;
          const rowHash = sha256Hex(
            `${doc.id}|${txnDate}|${amount}|${description.toLowerCase()}|${String(idx)}`
          );
          return {
            txnDate,
            description: description || null,
            amount,
            currency,
            rowHash,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      const result = await insertFinancialTransactions({
        documentId: doc.id,
        rows: normalizedRows,
      });
      insertedTransactions = result.insertedCount;

      const dates = normalizedRows.map((r) => r.txnDate).sort();
      const periodStart = dates.at(0) ?? null;
      const periodEnd = dates.at(-1) ?? null;
      const currency =
        normalizedRows.find((r) => typeof r.currency === "string" && r.currency.length > 0)
          ?.currency ?? null;

      const summaryText = [
        doc.documentType === "bank_statement" ? "Bank statement" : "Credit card statement",
        doc.accountHint ? `Account: ${doc.accountHint}` : "",
        periodStart && periodEnd ? `Period: ${periodStart}–${periodEnd}` : "",
        `Transactions: ${normalizedRows.length}`,
        `Filename: ${doc.filename}`,
      ]
        .filter((p) => p.length > 0)
        .join("\n");

      if (ingestSummaryToTurbopuffer) {
        await ingestDocSummaryToTurbopuffer({
          docId: doc.id,
          projectId: doc.projectId,
          isDefaultProject: project.isDefault,
          createdBy: doc.createdBy,
          organizationId: doc.organizationId,
          filename: doc.filename,
          mimeType: doc.mimeType,
          blobUrl: doc.blobUrl,
          sourceUrl: null,
          sourceCreatedAtMs: doc.createdAt.getTime(),
          documentType: doc.documentType,
          summaryText,
          metadata: {
            period_start: periodStart,
            period_end: periodEnd,
            currency,
            transaction_count: normalizedRows.length,
          },
        });
      }

      await updateProjectDoc({
        docId: doc.id,
        data: {
          currency,
          periodStart,
          periodEnd,
        },
      });
    } else {
      const obj = extracted as Record<string, unknown>;
      const header =
        obj.header && typeof obj.header === "object" ? (obj.header as Record<string, unknown>) : {};
      const lineItems = Array.isArray(obj.line_items) ? obj.line_items : [];

      const invoiceRow = await upsertInvoiceForDocument({
        documentId: doc.id,
        data: {
          vendor: typeof header.vendor === "string" ? header.vendor.trim().slice(0, 500) : null,
          invoiceNumber:
            typeof header.invoice_number === "string"
              ? header.invoice_number.trim().slice(0, 200)
              : null,
          invoiceDate: parseYmdDate(header.invoice_date),
          dueDate: parseYmdDate(header.due_date),
          subtotal: parseDecimalString(header.subtotal),
          tax: parseDecimalString(header.tax),
          total: parseDecimalString(header.total),
          currency: typeof header.currency === "string" ? header.currency.trim().slice(0, 16) : null,
        },
      });

      const normalizedLineItems = lineItems
        .map((li) => (li && typeof li === "object" ? (li as Record<string, unknown>) : null))
        .filter((li): li is Record<string, unknown> => li !== null)
        .map((li, idx) => {
          const description = normalizeDescription(li.description);
          const quantity = li.quantity === null ? null : parseDecimalString(li.quantity);
          const unitPrice = li.unit_price === null ? null : parseDecimalString(li.unit_price);
          const amount = li.amount === null ? null : parseDecimalString(li.amount);
          const rowHash = sha256Hex(
            `${invoiceRow.id}|${description.toLowerCase()}|${quantity ?? ""}|${unitPrice ?? ""}|${amount ?? ""}|${String(idx)}`
          );
          return {
            description: description || null,
            quantity,
            unitPrice,
            amount,
            rowHash,
          };
        });

      const result = await insertInvoiceLineItems({
        invoiceId: invoiceRow.id,
        rows: normalizedLineItems,
      });
      insertedLineItems = result.insertedCount;

      const summaryText = [
        "Invoice",
        invoiceRow.vendor ? `Vendor: ${invoiceRow.vendor}` : "",
        invoiceRow.invoiceNumber ? `Invoice #: ${invoiceRow.invoiceNumber}` : "",
        invoiceRow.invoiceDate ? `Invoice date: ${invoiceRow.invoiceDate}` : "",
        invoiceRow.total ? `Total: ${invoiceRow.total}` : "",
        `Line items: ${normalizedLineItems.length}`,
        `Filename: ${doc.filename}`,
      ]
        .filter((p) => p.length > 0)
        .join("\n");

      if (ingestSummaryToTurbopuffer) {
        await ingestDocSummaryToTurbopuffer({
          docId: doc.id,
          projectId: doc.projectId,
          isDefaultProject: project.isDefault,
          createdBy: doc.createdBy,
          organizationId: doc.organizationId,
          filename: doc.filename,
          mimeType: doc.mimeType,
          blobUrl: doc.blobUrl,
          sourceUrl: null,
          sourceCreatedAtMs: doc.createdAt.getTime(),
          documentType: "invoice",
          summaryText,
          metadata: {
            vendor: invoiceRow.vendor,
            invoice_number: invoiceRow.invoiceNumber,
            invoice_date: invoiceRow.invoiceDate,
            total: invoiceRow.total,
            currency: invoiceRow.currency,
            line_item_count: normalizedLineItems.length,
          },
        });
      }

      await updateProjectDoc({
        docId: doc.id,
        data: {
          currency: invoiceRow.currency,
        },
      });
    }

    await updateProjectDoc({
      docId: doc.id,
      data: {
        extractedJsonBlobUrl: extractedBlob.url,
        schemaId,
        schemaVersion,
        parseStatus: "parsed",
        parseError: null,
      },
    });

    return {
      ok: true,
      documentType: doc.documentType,
      schemaId,
      insertedTransactions,
      insertedLineItems,
    };
  } catch (error) {
    let message = error instanceof Error ? error.message : "Parse failed";
    if (error instanceof ChatSDKError && error.cause) {
      message += ` (Cause: ${error.cause})`;
    } else if (error instanceof Error && "cause" in error && error.cause) {
      message += ` (Cause: ${error.cause})`;
    }

    await updateProjectDoc({
      docId: doc.id,
      data: {
        parseStatus: "failed",
        parseError: message,
      },
    });
    return { ok: false, error: message };
  }
}


