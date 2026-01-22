import "server-only";

import type { Session } from "next-auth";
import { z } from "zod";
import {
  financeGroupByDescription,
  financeGroupByCategory,
  financeGroupByMerchant,
  financeGroupByMonth,
  financeList,
  financeSum, 
  getProjectEntitySummaryForUser,
} from "@/lib/db/queries";
import {
  SpecialistAgentResponseSchema,
  type SpecialistAgentResponse,
} from "@/lib/ai/agents/types";

const FinanceAgentInputSchema = z.object({
  question: z.string().min(1).max(4000),
  projectId: z.string().uuid().optional(),
  entity_hint: z
    .object({
      entity_kind: z.enum(["personal", "business"]).optional(),
      entity_name: z.string().min(1).max(200).optional(),
    })
    .optional(),
  entity_hints: z
    .array(
      z.object({
        entity_kind: z.enum(["personal", "business"]).optional(),
        entity_name: z.string().min(1).max(200).optional(),
      })
    )
    .optional(),
  time_hint: z
    .object({
      kind: z.enum(["year", "month"]).optional(),
      year: z.number().int().min(1900).max(2200).optional(),
      month: z.number().int().min(1).max(12).optional(),
    })
    .optional(),
});
export type FinanceAgentInput = z.infer<typeof FinanceAgentInputSchema>;

type DateRange = { date_start: string; date_end: string; label: string };

const monthMap: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

function inferYear(text: string, fallback: number) {
  const m = text.match(/\b(19\d{2}|20\d{2})\b/);
  if (!m) return fallback;
  const y = Number(m[1]);
  return Number.isFinite(y) && y >= 1900 && y <= 2200 ? y : fallback;
}

function toYmd(y: number, m: number, d: number) {
  const yyyy = String(y).padStart(4, "0");
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysIso(ymd: string, days: number) {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(dt.getTime())) return null;
  dt.setUTCDate(dt.getUTCDate() + days);
  return toYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function inferDateRange(textLower: string, timeHint: FinanceAgentInput["time_hint"] | undefined): DateRange | null {
  const nowYear = new Date().getUTCFullYear();
  const year =
    (timeHint?.kind === "year" && typeof timeHint.year === "number" ? timeHint.year : null) ??
    inferYear(textLower, nowYear);

  // Explicit ISO range: from 2025-06-01 to 2025-08-31 (end is inclusive)
  const iso = Array.from(textLower.matchAll(/\b(19\d{2}|20\d{2})-\d{2}-\d{2}\b/g)).map((m) => m[0]);
  if (iso.length >= 2) {
    const start = iso[0];
    const endInclusive = iso[1];
    const endExclusive = addDaysIso(endInclusive, 1);
    if (endExclusive) return { date_start: start, date_end: endExclusive, label: `${start}..${endInclusive}` };
  }

  // Month name(s) range: "June and August 2025" => 2025-06-01..2025-09-01
  const months: number[] = [];
  for (const [k, v] of Object.entries(monthMap)) {
    if (textLower.includes(k) && !months.includes(v)) months.push(v);
  }
  months.sort((a, b) => a - b);
  if (months.length >= 2) {
    const startM = months[0];
    const endM = months[months.length - 1];
    const start = toYmd(year, startM, 1);
    const endYear = endM === 12 ? year + 1 : year;
    const endMonth = endM === 12 ? 1 : endM + 1;
    const end = toYmd(endYear, endMonth, 1);
    return { date_start: start, date_end: end, label: `${year}-${String(startM).padStart(2, "0")}..${year}-${String(endM).padStart(2, "0")}` };
  }
  if (months.length === 1) {
    const m = months[0];
    const start = toYmd(year, m, 1);
    const endYear = m === 12 ? year + 1 : year;
    const endMonth = m === 12 ? 1 : m + 1;
    const end = toYmd(endYear, endMonth, 1);
    return { date_start: start, date_end: end, label: `${year}-${String(m).padStart(2, "0")}` };
  }

  // Year window
  if (textLower.includes(String(year))) {
    return { date_start: `${year}-01-01`, date_end: `${year + 1}-01-01`, label: `${year}` };
  }
  return null;
}

function inferEntity(
  textLower: string,
  hint: FinanceAgentInput["entity_hint"] | undefined
): { kind: "personal" | "business" | null; name: string | null } {
  const hintedKind = hint?.entity_kind;
  const hintedName = typeof hint?.entity_name === "string" ? hint.entity_name.trim() : "";
  if (hintedKind === "personal") return { kind: "personal", name: null };
  if (hintedKind === "business") return { kind: "business", name: hintedName || null };
  if (textLower.includes("personal")) return { kind: "personal", name: null };
  if (textLower.includes("business")) return { kind: "business", name: hintedName || null };
  return { kind: null, name: hintedName || null };
}

function inferDocType(textLower: string): "cc_statement" | "bank_statement" {
  const cc =
    textLower.includes("amex") ||
    textLower.includes("american express") ||
    textLower.includes("credit card") ||
    textLower.includes("card") ||
    textLower.includes("transactions") ||
    textLower.includes("charges") ||
    textLower.includes("spent") ||
    textLower.includes("spend");
  return cc ? "cc_statement" : "bank_statement";
}

function inferCategory(textLower: string): string | null {
  // Return a substring used for category_contains (ILIKE) so it matches detailed categories
  // like "Merchandise & Supplies-Groceries".
  if (textLower.includes("grocery") || textLower.includes("groceries")) return "groc";
  if (textLower.includes("travel")) return "travel";
  if (textLower.includes("gas") || textLower.includes("fuel")) return "fuel";
  if (textLower.includes("subscription")) return "subscription";
  if (textLower.includes("coffee")) return "coffee";
  if (textLower.includes("dining") || textLower.includes("restaurant") || textLower.includes("food"))
    return "restaurant";
  return null;
}

function inferCategoryFromContext(context: string): string | null {
  const lower = context.toLowerCase();
  // Prefer explicit markers we generate.
  const m = lower.match(/category_contains["']?\s*[:=]\s*["']([a-z]{3,20})["']/);
  if (m?.[1]) return m[1];
  const paren = lower.match(/\((coffee|groc|travel|fuel|subscription|restaurant)\)/);
  if (paren?.[1]) return paren[1];
  // Or a category table row like "| coffee |"
  const table = lower.match(/\|\s*(coffee|groceries|travel|gas|subscriptions?|restaurant)\s*\|/);
  if (table?.[1]) {
    const v = table[1];
    if (v.startsWith("groc")) return "groc";
    if (v.startsWith("sub")) return "subscription";
    if (v.startsWith("rest")) return "restaurant";
    if (v === "gas") return "fuel";
    return v;
  }
  return null;
}

function wantsList(textLower: string) {
  return (
    textLower.includes("list") ||
    textLower.includes("show") ||
    textLower.includes("individual") ||
    textLower.includes("transactions") ||
    textLower.includes("transaction") ||
    textLower.includes("details")
  );
}

function inferTopN(textLower: string): number | null {
  const m = textLower.match(/\btop\s+(\d{1,2})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(50, n);
}

function toGfmTable(headers: readonly string[], rows: readonly (readonly string[])[]) {
  const esc = (v: string) => v.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", " ").trim();
  const headerLine = `| ${headers.map(esc).join(" | ")} |`;
  const sepLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map((c) => esc(c)).join(" | ")} |`);
  return [headerLine, sepLine, ...body].join("\n");
}

function coerceNonNegativeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return null;
}

function buildChartPayload({
  title,
  breakdown,
  rows,
  labelKey,
}: {
  title: string;
  breakdown: "category" | "month" | "merchant" | "description";
  rows: unknown[];
  labelKey: "category" | "month" | "merchant" | "description";
}):
  | {
      version: 1;
      title: string;
      breakdown: "category" | "month" | "merchant" | "description";
      unit: "USD";
      rows: Array<{ label: string; value: number; count?: number }>;
    }
  | null {
  const out: Array<{ label: string; value: number; count?: number }> = [];

  for (const r of rows.slice(0, 250)) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;

    const rawLabel = rec[labelKey];
    const label =
      typeof rawLabel === "string" && rawLabel.trim().length > 0
        ? rawLabel.trim()
        : labelKey === "category"
          ? "Uncategorized"
          : "(unknown)";

    const rawTotal = rec.total;
    const value = coerceNonNegativeNumber(
      typeof rawTotal === "string" ? rawTotal.replace(/^-/, "") : rawTotal
    );
    if (value === null) continue;

    const count =
      typeof rec.count === "number" && Number.isFinite(rec.count) && rec.count >= 0
        ? Math.floor(rec.count)
        : undefined;

    out.push({
      label: label.slice(0, 120),
      value,
      ...(typeof count === "number" ? { count } : {}),
    });
  }

  if (out.length === 0) return null;

  out.sort((a, b) => b.value - a.value);

  return {
    version: 1,
    title: title.slice(0, 140),
    breakdown,
    unit: "USD",
    rows: out,
  };
}

function entityLabel(entity: { kind: "personal" | "business" | null; name: string | null }) {
  if (entity.kind === "personal") return "Personal";
  if (entity.kind === "business") return entity.name || "Business";
  return "Unknown";
}

export async function runFinanceAgent({
  session,
  projectId,
  input,
}: {
  session: Session;
  projectId?: string;
  input: FinanceAgentInput;
}): Promise<SpecialistAgentResponse> {
  const parsed = FinanceAgentInputSchema.parse({ ...input, projectId: projectId ?? input.projectId });
  const q = parsed.question.trim();
  const parts = q.split("\n\nContext (recent turns):");
  const mainQuestion = (parts.at(0) ?? "").trim();
  const contextText = (parts.length > 1 ? parts.slice(1).join("\n\n") : "").trim();
  const mainLower = mainQuestion.toLowerCase();
  const qLower = q.toLowerCase();

  if (!session.user?.id) {
    return SpecialistAgentResponseSchema.parse({
      kind: "finance",
      answer_draft: "",
      questions_for_user: ["You need to be signed in to run finance queries."],
      assumptions: [],
      tool_calls: [],
      citations: [],
      confidence: "low",
    });
  }

  if (!parsed.projectId) {
    return SpecialistAgentResponseSchema.parse({
      kind: "finance",
      answer_draft: "",
      questions_for_user: ["No project is selected. Please select a project and try again."],
      assumptions: [],
      tool_calls: [],
      citations: [],
      confidence: "low",
    });
  }

  // Use full text (including context) to recover missing time/entity.
  const range = inferDateRange(qLower, parsed.time_hint);
  const docType = inferDocType(qLower);
  
  // Determine which entities to use: prioritize entity_hints (multiple), then entity_hint (single), then infer from text
  const entitiesToUse: Array<{ kind: "personal" | "business"; name: string | null }> = [];
  if (parsed.entity_hints && parsed.entity_hints.length > 0) {
    // Use provided entity hints
    for (const hint of parsed.entity_hints) {
      if (hint.entity_kind === "personal") {
        entitiesToUse.push({ kind: "personal", name: null });
      } else if (hint.entity_kind === "business" && hint.entity_name) {
        entitiesToUse.push({ kind: "business", name: hint.entity_name });
      }
    }
  }
  
  // If no entities from hints, use single entity_hint or infer
  const entity = entitiesToUse.length === 0 
    ? inferEntity(qLower, parsed.entity_hint)
    : entitiesToUse[0];

  // Allow explicit entity injection from the router (used for clarification follow-ups).
  const explicitBusinessName = q.match(/\bBusiness\s*:\s*([^\n\r]{2,120})/i)?.[1]?.trim();
  if (explicitBusinessName) {
    if (entitiesToUse.length === 0) {
      entitiesToUse.push({ kind: "business", name: explicitBusinessName });
    } else {
      // Update first entity if we have explicit business name
      entitiesToUse[0] = { kind: "business", name: explicitBusinessName };
    }
    entity.kind = "business";
    entity.name = explicitBusinessName;
  } else if (/\bEntity\s*:\s*Personal\b/i.test(q)) {
    if (entitiesToUse.length === 0) {
      entitiesToUse.push({ kind: "personal", name: null });
    } else {
      entitiesToUse[0] = { kind: "personal", name: null };
    }
    entity.kind = "personal";
    entity.name = null;
  }
  
  // If we have multiple entities, we'll process them all
  const hasMultipleEntities = entitiesToUse.length > 1;

  // Only infer category + presentation intent from the user's actual message,
  // not from appended context (which may contain misleading tokens like "gas"/"fuel").
  const category = inferCategory(mainLower);
  const wantsByDescriptionGlobal =
    mainLower.includes("by description") || mainLower.includes("by memo") || mainLower.includes("by details");
  const list = wantsList(mainLower) && !wantsByDescriptionGlobal;

  // If entity is missing, use project entity summary to decide whether we need clarification.
  if (!entity.kind) {
    const summary = await getProjectEntitySummaryForUser({
      userId: session.user.id,
      projectId: parsed.projectId,
    });
    const businessNames = summary
      .filter((e) => e.entityKind === "business" && typeof e.entityName === "string")
      .map((e) => (e.entityName as string).trim())
      .filter((n) => n.length > 0);
    const matchedFromText =
      businessNames
        .map((n) => ({ n, lower: n.toLowerCase() }))
        .filter(({ lower }) => lower.length >= 3 && qLower.includes(lower))
        .sort((a, b) => b.lower.length - a.lower.length)[0]?.n ?? null;
    if (matchedFromText) {
      entity.kind = "business";
      entity.name = matchedFromText;
    }
    const hasPersonal = summary.some((e) => e.entityKind === "personal");
    const options = [
      ...(hasPersonal ? ["Personal"] : []),
      ...Array.from(new Set(businessNames)).sort((a, b) => a.localeCompare(b)),
    ];
    if (!entity.kind && options.length > 1) {
      const availableEntities: Array<{ kind: "personal" | "business"; name: string | null }> = [];
      if (hasPersonal) {
        availableEntities.push({ kind: "personal", name: null });
      }
      for (const businessName of Array.from(new Set(businessNames))) {
        availableEntities.push({ kind: "business", name: businessName });
      }
      return SpecialistAgentResponseSchema.parse({
        kind: "finance",
        answer_draft: "",
        questions_for_user: [],
        assumptions: [],
        tool_calls: [],
        citations: [],
        confidence: "low",
        needs_entity_selection: {
          available_entities: availableEntities,
        },
      });
    }
    if (!entity.kind && options.length === 1 && options[0] === "Personal") {
      entity.kind = "personal";
    } else if (options.length === 1) {
      entity.kind = "business";
      entity.name = options[0];
    }
  }

  if (!range) {
    return SpecialistAgentResponseSchema.parse({
      kind: "finance",
      answer_draft: "",
      questions_for_user: [
        "What time window should I use? (e.g. 2025, June 2025, or 2025-06-01 to 2025-09-01)",
      ],
      assumptions: [],
      tool_calls: [],
      citations: [],
      confidence: "low",
    });
  }

  // If business was requested but name is missing, ask.
  if (entity.kind === "business" && (!entity.name || !entity.name.trim())) {
    const summary = await getProjectEntitySummaryForUser({
      userId: session.user.id,
      projectId: parsed.projectId,
    });
    const businessNames = summary
      .filter((e) => e.entityKind === "business" && typeof e.entityName === "string")
      .map((e) => (e.entityName as string).trim())
      .filter((n) => n.length > 0);
    const matchedFromText =
      businessNames
        .map((n) => ({ n, lower: n.toLowerCase() }))
        .filter(({ lower }) => lower.length >= 3 && qLower.includes(lower))
        .sort((a, b) => b.lower.length - a.lower.length)[0]?.n ?? null;
    if (matchedFromText) {
      entity.name = matchedFromText;
    }
    if (entity.name && entity.name.trim()) {
      // proceed
    } else {
    return SpecialistAgentResponseSchema.parse({
      kind: "finance",
      answer_draft: "",
      questions_for_user: [
        businessNames.length > 0
          ? `Which business should I use? (${Array.from(new Set(businessNames)).join(", ")})`
          : "Which business should I use?",
      ],
      assumptions: [],
      tool_calls: [],
      citations: [],
      confidence: "low",
    });
    }
  }

  const wantsMerchant = mainLower.includes("merchant") || mainLower.includes("merchants");
  const categoryForFilters =
    category ?? (wantsMerchant && contextText ? inferCategoryFromContext(contextText) : null);

  // Helper to build filters for a specific entity
  const buildFiltersForEntity = (e: { kind: "personal" | "business"; name: string | null }) => ({
    ...(e.kind === "personal"
      ? { entity_kind: "personal" as const }
      : { entity_kind: "business" as const, entity_name: e.name ?? "" }),
    date_start: range.date_start,
    date_end: range.date_end,
    ...(categoryForFilters ? { category_contains: categoryForFilters } : {}),
  });

  const baseFilters = entity.kind ? buildFiltersForEntity(entity as { kind: "personal" | "business"; name: string | null }) : {
    date_start: range.date_start,
    date_end: range.date_end,
    ...(categoryForFilters ? { category_contains: categoryForFilters } : {}),
  };

  // If the question looks like "did I spend on <category>" but doesn't mention card/bank,
  // bank-vs-cc inference can be wrong. When a category is present, prefer cc spend if bank would return 0.
  const shouldPreferCcOnCategory =
    docType === "bank_statement" &&
    Boolean(category) &&
    (mainLower.includes("spent") || mainLower.includes("spend")) &&
    !mainLower.includes("deposit") &&
    !mainLower.includes("income");

  // Helper to get entity label(s) for display
  const getEntityLabel = () => {
    if (hasMultipleEntities && entitiesToUse.length > 1) {
      return entitiesToUse.map((e) => e.kind === "personal" ? "Personal" : e.name || "Business").join(" + ");
    }
    return entity.kind === "personal" ? "Personal" : entity.name || "Business";
  };

  // For cc statements we treat "spend" as charges; try positive first, then negatives.
  if (docType === "cc_statement") {
    const topN = wantsMerchant ? inferTopN(mainLower) : null;
    if (list) {
      // Helper to list across multiple entities
      type TransactionRow = {
        txnDate: string;
        description: string | null;
        merchant: string | null;
        category: string | null;
        amount: string;
      };
      const listAcrossEntities = async (
        amountFilter: { amount_min?: number; amount_max?: number }
      ): Promise<TransactionRow[]> => {
        if (hasMultipleEntities && entitiesToUse.length > 1) {
          // Merge lists from all entities
          const allRows: TransactionRow[] = [];
          for (const e of entitiesToUse) {
            const filters = { ...buildFiltersForEntity(e), ...amountFilter };
            const result = await financeList({
              userId: session.user.id,
              projectId: parsed.projectId,
              documentType: "cc_statement",
              filters,
            });
            if (result.query_type === "list") {
              allRows.push(...(result.rows as TransactionRow[]));
            }
          }
          // Sort by date descending
          return allRows.sort((a, b) => b.txnDate.localeCompare(a.txnDate));
        } else {
          // Single entity
          const result = await financeList({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType: "cc_statement",
            filters: { ...baseFilters, ...amountFilter },
          });
          return result.query_type === "list" ? (result.rows as TransactionRow[]) : [];
        }
      };

      const posRows = await listAcrossEntities({ amount_min: 0.01 });
      const neg =
        posRows.length === 0
          ? await listAcrossEntities({ amount_max: -0.01 })
          : null;
      const rows = neg && neg.length > 0 ? neg : posRows;
      const negAmounts = Boolean(neg && neg.length > 0);

      const tableRows = rows.slice(0, 200).map((r) => {
        const label = (r.description?.trim() || r.merchant?.trim() || "(no description)").slice(0, 80);
        const amt = negAmounts && r.amount.startsWith("-") ? r.amount.slice(1) : r.amount;
        const cat = r.category?.trim() || "Uncategorized";
        return [r.txnDate, label, `$${amt}`, cat];
      });
      const table = tableRows.length > 0 ? toGfmTable(["Date", "Description", "Amount", "Category"], tableRows) : "";

      return SpecialistAgentResponseSchema.parse({
        kind: "finance",
        answer_draft: [
          `Transactions for ${range.label}${category ? ` (category=${category})` : ""}:`,
          `Transactions: ${rows.length}${rows.length > 200 ? " (showing first 200)" : ""}`,
          "",
          table,
        ]
          .filter((s) => s.length > 0)
          .join("\n"),
        questions_for_user: rows.length === 0 ? ["I found 0 matching transactions. Is the date range/entity correct?"] : [],
        assumptions: [
          "For credit cards, charges may be stored as positive or negative amounts depending on export; this tries both conventions.",
        ],
        tool_calls: [],
        citations: [],
        confidence: rows.length === 0 ? "low" : "medium",
      });
    }

    // Helper to sum across multiple entities
    const sumAcrossEntities = async (
      documentType: "cc_statement" | "bank_statement",
      amountFilter: { amount_min?: number; amount_max?: number }
    ): Promise<{ total: string; count: number }> => {
      if (hasMultipleEntities && entitiesToUse.length > 1) {
        // Sum across all entities
        let combinedTotal = 0;
        let combinedCount = 0;
        for (const e of entitiesToUse) {
          const filters = { ...buildFiltersForEntity(e), ...amountFilter };
          const result = (await financeSum({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType,
            filters,
          })) as { total: string; count: number };
          combinedTotal += parseFloat(result.total) || 0;
          combinedCount += result.count || 0;
        }
        return {
          total: combinedTotal.toFixed(2),
          count: combinedCount,
        };
      } else {
        // Single entity - use existing logic
        return (await financeSum({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType,
          filters: { ...baseFilters, ...amountFilter },
        })) as { total: string; count: number };
      }
    };

    const sumPos = await sumAcrossEntities("cc_statement", { amount_min: 0.01 });
    const sumNeg =
      sumPos.count === 0
        ? await sumAcrossEntities("cc_statement", { amount_max: -0.01 })
        : null;
    const used = sumNeg && sumNeg.count > 0 ? sumNeg : sumPos;
    const total = used.total.startsWith("-") ? used.total.slice(1) : used.total;
    const signNote = sumNeg && sumNeg.count > 0 ? " (note: amounts were stored as negatives; shown as absolute)" : "";

    // If a category filter was specified and cc_statement returned 0 rows, fall back to
    // bank_statement withdrawals. Some datasets store rich categories on bank exports instead.
    if (used.count === 0 && category) {
      const bankSum = await financeSum({
        userId: session.user.id,
        projectId: parsed.projectId,
        documentType: "bank_statement",
        filters: { ...baseFilters, amount_max: -0.01 },
      });
      const count = typeof bankSum.count === "number" ? bankSum.count : 0;
      if (count > 0) {
        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: `Spend on ${getEntityLabel()} (${category}) in ${range.label}: $${bankSum.total} (${count} transactions).`,
          questions_for_user: [],
          assumptions: ["Matched category against bank_statement withdrawals (amount < 0)."],
          tool_calls: [
            {
              toolName: "financeSum",
              input: {
                document_type: "bank_statement",
                ...baseFilters,
                amount_max: -0.01,
              },
              output: bankSum,
            },
          ],
          citations: [],
          confidence: "medium",
        });
      }
    }

    // Helper to group across multiple entities
    const groupAcrossEntities = async (
      groupByFn: (args: {
        userId: string;
        projectId?: string;
        documentType: "cc_statement" | "bank_statement";
        filters?: any;
      }) => Promise<any>,
      amountFilter: { amount_min?: number; amount_max?: number }
    ): Promise<any> => {
      if (hasMultipleEntities && entitiesToUse.length > 1) {
        // Run groupBy for each entity and merge results
        const allResults: Array<{ [key: string]: any }> = [];
        for (const e of entitiesToUse) {
          const filters = { ...buildFiltersForEntity(e), ...amountFilter };
          const result = await groupByFn({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType: "cc_statement",
            filters,
          });
          if (result && Array.isArray(result.rows)) {
            allResults.push(...result.rows);
          }
        }
        // Merge by grouping key (month, merchant, category, description)
        const merged = new Map<string, { [key: string]: any }>();
        for (const row of allResults) {
          const key = row.month || row.merchant || row.category || row.description || "";
          if (key) {
            const existing = merged.get(key);
            if (existing) {
              existing.amount = (parseFloat(existing.amount) + parseFloat(row.amount || "0")).toFixed(2);
              existing.count = (existing.count || 0) + (row.count || 0);
            } else {
              merged.set(key, { ...row, amount: parseFloat(row.amount || "0").toFixed(2) });
            }
          }
        }
        return { rows: Array.from(merged.values()) };
      } else {
        // Single entity
        return await groupByFn({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "cc_statement",
          filters: { ...baseFilters, ...amountFilter },
        });
      }
    };

    const amountFilterForGroup = sumNeg && sumNeg.count > 0 ? { amount_max: -0.01 } : { amount_min: 0.01 };
    const grouped = qLower.includes("by month")
      ? await groupAcrossEntities(financeGroupByMonth, amountFilterForGroup)
      : wantsByDescriptionGlobal
        ? await groupAcrossEntities(financeGroupByDescription, amountFilterForGroup)
      : wantsMerchant
        ? await groupAcrossEntities(financeGroupByMerchant, amountFilterForGroup)
        : qLower.includes("by category") || category
          ? await groupAcrossEntities(financeGroupByCategory, amountFilterForGroup)
          : await groupAcrossEntities(financeGroupByMerchant, amountFilterForGroup);

    const rows = Array.isArray((grouped as any).rows) ? ((grouped as any).rows as any[]) : [];
    const chartPayload = (() => {
      const label = getEntityLabel();
      if (qLower.includes("by month")) {
        return buildChartPayload({
          title: `Spend by month (${label}, ${range.label})`,
          breakdown: "month",
          rows,
          labelKey: "month",
        });
      }
      if (wantsByDescriptionGlobal) {
        return buildChartPayload({
          title: `Spend by description (${label}, ${range.label})`,
          breakdown: "description",
          rows,
          labelKey: "description",
        });
      }
      if (qLower.includes("by category") || category) {
        return buildChartPayload({
          title: `Spend by category (${label}, ${range.label})`,
          breakdown: "category",
          rows,
          labelKey: "category",
        });
      }
      return buildChartPayload({
        title: `Spend by merchant (${label}, ${range.label})`,
        breakdown: "merchant",
        rows,
        labelKey: "merchant",
      });
    })();
    const table = chartPayload
      ? ""
      : (() => {
      if (rows.length === 0) return "";
      if (qLower.includes("by month")) {
        return toGfmTable(
          ["Month", "Total", "Transactions"],
          rows.slice(0, 24).map((r) => [String(r.month), `$${String(r.total).replace(/^-/, "")}`, String(r.count)])
        );
      }
      if (qLower.includes("by category") || category) {
        return toGfmTable(
          ["Category", "Total", "Transactions"],
          rows.slice(0, 24).map((r) => [String(r.category ?? "Uncategorized"), `$${String(r.total).replace(/^-/, "")}`, String(r.count)])
        );
      }
      if (wantsMerchant && typeof topN === "number") {
        return toGfmTable(
          ["Merchant", "Total", "Transactions"],
          rows.slice(0, topN).map((r) => [
            String(r.merchant ?? "(unknown)"),
            `$${String(r.total).replace(/^-/, "")}`,
            String(r.count),
          ])
        );
      }
      return toGfmTable(
        ["Merchant", "Total", "Transactions"],
        rows.slice(0, 24).map((r) => [String(r.merchant ?? "(unknown)"), `$${String(r.total).replace(/^-/, "")}`, String(r.count)])
      );
    })();

    return SpecialistAgentResponseSchema.parse({
      kind: "finance",
      answer_draft: [
        `Spend on ${getEntityLabel()}${category ? ` (${category})` : ""} in ${range.label}: $${total}${signNote} (${used.count} Transactions).`,
        table ? "" : "",
        table ? `\n${table}` : "",
      ]
        .filter((s) => s.length > 0)
        .join(""),
      questions_for_user: [],
      assumptions: ["Spend is computed from cc_statement transactions for the requested time window."],
      tool_calls: [
        {
          toolName: "financeSum",
          input: {
            document_type: "cc_statement",
            ...baseFilters,
            amount_min: 0.01,
          },
          output: sumPos,
        },
        ...(sumNeg
          ? [
              {
                toolName: "financeSum",
                input: {
                  document_type: "cc_statement",
                  ...baseFilters,
                  amount_max: -0.01,
                },
                output: sumNeg,
              },
            ]
          : []),
      ],
      citations: [],
      confidence: used.count === 0 ? "low" : "medium",
      chart_payload: chartPayload ?? undefined,
    });
  }

  // Bank statement: treat spend as withdrawals (amount < 0) unless user is asking income/deposits.
  const isIncomeLike = qLower.includes("income") || qLower.includes("deposit") || qLower.includes("deposits") || qLower.includes("revenue");
  const amountFilter = isIncomeLike ? { amount_min: 0.01 } : { amount_max: -0.01 };
  const wantsByDescription =
    mainLower.includes("by description") || mainLower.includes("by memo") || mainLower.includes("by details");

  if (shouldPreferCcOnCategory) {
    const ccSum = (await financeSum({
      userId: session.user.id,
      projectId: parsed.projectId,
      documentType: "cc_statement",
      filters: { ...baseFilters, amount_min: 0.01 },
    })) as { total: string; count: number };
    if (ccSum.count > 0) {
      return SpecialistAgentResponseSchema.parse({
        kind: "finance",
        answer_draft: `Spend on ${getEntityLabel()} (${category}) in ${range.label}: $${ccSum.total} (${ccSum.count} Transactions).`,
        questions_for_user: [],
        assumptions: ["Matched category against cc_statement transactions (charges only)."],
        tool_calls: [],
        citations: [],
        confidence: "medium",
      });
    }
  }

  if (list) {
    // Helper to list bank transactions across multiple entities
    type BankTransactionRow = {
      txnDate: string;
      description: string | null;
      category: string | null;
      amount: string;
    };
    const listBankAcrossEntities = async (): Promise<BankTransactionRow[]> => {
      if (hasMultipleEntities && entitiesToUse.length > 1) {
        const allRows: BankTransactionRow[] = [];
        for (const e of entitiesToUse) {
          const filters = { ...buildFiltersForEntity(e), ...amountFilter };
          const result = await financeList({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType: "bank_statement",
            filters,
          });
          if (result.query_type === "list") {
            allRows.push(...(result.rows as BankTransactionRow[]));
          }
        }
        return allRows.sort((a, b) => b.txnDate.localeCompare(a.txnDate));
      } else {
        const out = await financeList({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "bank_statement",
          filters: { ...baseFilters, ...amountFilter },
        });
        return out.query_type === "list" ? (out.rows as BankTransactionRow[]) : [];
      }
    };
    const rows = await listBankAcrossEntities();
    const tableRows = rows.slice(0, 200).map((r) => {
      const desc = (r.description?.trim() || "(no description)").slice(0, 90);
      const cat = r.category?.trim() || "Uncategorized";
      return [r.txnDate, desc, `$${r.amount}`, cat];
    });
    const table = tableRows.length > 0 ? toGfmTable(["Date", "Description", "Amount", "Category"], tableRows) : "";
    return SpecialistAgentResponseSchema.parse({
      kind: "finance",
      answer_draft: [
        `Transactions for ${range.label}${isIncomeLike ? " (deposits)" : " (spend/withdrawals)"}:`,
        `Transactions: ${rows.length}${rows.length > 200 ? " (showing first 200)" : ""}`,
        "",
        table,
      ]
        .filter((s) => s.length > 0)
        .join("\n"),
      questions_for_user: rows.length === 0 ? ["I found 0 matching transactions. Is the date range/entity correct?"] : [],
      assumptions: [],
      tool_calls: [],
      citations: [],
      confidence: rows.length === 0 ? "low" : "medium",
    });
  }

  // Sum bank transactions across multiple entities
  const sum = hasMultipleEntities && entitiesToUse.length > 1
    ? (async () => {
        let combinedTotal = 0;
        let combinedCount = 0;
        for (const e of entitiesToUse) {
          const filters = { ...buildFiltersForEntity(e), ...amountFilter };
          const result = (await financeSum({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType: "bank_statement",
            filters,
          })) as { total: string; count: number };
          combinedTotal += parseFloat(result.total) || 0;
          combinedCount += result.count || 0;
        }
        return {
          total: combinedTotal.toFixed(2),
          count: combinedCount,
        };
      })()
    : await financeSum({
        userId: session.user.id,
        projectId: parsed.projectId,
        documentType: "bank_statement",
        filters: { ...baseFilters, ...amountFilter },
      });
  const sumResult = await sum;

  const wantsMerchantBank = mainLower.includes("merchant") || mainLower.includes("by merchant");
  const wantsByMonthDefault = isIncomeLike && !mainLower.includes("by ");
  
  // Helper to group bank transactions across multiple entities
  const groupBankAcrossEntities = async (
    groupByFn: (args: {
        userId: string;
        projectId?: string;
        documentType: "bank_statement";
        filters?: any;
      }) => Promise<any>
    ): Promise<any> => {
      if (hasMultipleEntities && entitiesToUse.length > 1) {
        const allResults: Array<{ [key: string]: any }> = [];
        for (const e of entitiesToUse) {
          const filters = { ...buildFiltersForEntity(e), ...amountFilter };
          const result = await groupByFn({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType: "bank_statement",
            filters,
          });
          if (result && Array.isArray(result.rows)) {
            allResults.push(...result.rows);
          }
        }
        // Merge by grouping key
        const merged = new Map<string, { [key: string]: any }>();
        for (const row of allResults) {
          const key = row.month || row.merchant || row.category || row.description || "";
          if (key) {
            const existing = merged.get(key);
            if (existing) {
              existing.total = (parseFloat(existing.total) + parseFloat(row.total || "0")).toFixed(2);
              existing.count = (existing.count || 0) + (row.count || 0);
            } else {
              merged.set(key, { ...row, total: parseFloat(row.total || "0").toFixed(2) });
            }
          }
        }
        return { rows: Array.from(merged.values()) };
      } else {
        return await groupByFn({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "bank_statement",
          filters: { ...baseFilters, ...amountFilter },
        });
      }
    };

  const grouped = qLower.includes("by month") || wantsByMonthDefault
    ? await groupBankAcrossEntities(financeGroupByMonth)
    : wantsByDescription
      ? await groupBankAcrossEntities(financeGroupByDescription)
    : wantsMerchantBank
      ? await groupBankAcrossEntities(financeGroupByMerchant)
      : await groupBankAcrossEntities(financeGroupByCategory);

  const rows = Array.isArray((grouped as any).rows) ? ((grouped as any).rows as any[]) : [];
  const chartPayload = (() => {
    const label = getEntityLabel();
    if (qLower.includes("by month") || wantsByMonthDefault) {
      return buildChartPayload({
        title: `${isIncomeLike ? "Deposits" : "Spend"} by month (${label}, ${range.label})`,
        breakdown: "month",
        rows,
        labelKey: "month",
      });
    }
    if (wantsByDescription) {
      return buildChartPayload({
        title: `${isIncomeLike ? "Deposits" : "Spend"} by description (${label}, ${range.label})`,
        breakdown: "description",
        rows,
        labelKey: "description",
      });
    }
    if (wantsMerchantBank) {
      return buildChartPayload({
        title: `${isIncomeLike ? "Deposits" : "Spend"} by merchant (${label}, ${range.label})`,
        breakdown: "merchant",
        rows,
        labelKey: "merchant",
      });
    }
    return buildChartPayload({
      title: `${isIncomeLike ? "Deposits" : "Spend"} by category (${label}, ${range.label})`,
      breakdown: "category",
      rows,
      labelKey: "category",
    });
  })();
  const table = chartPayload
    ? ""
    : rows.length === 0
      ? ""
      : qLower.includes("by month") || wantsByMonthDefault
        ? toGfmTable(
            ["Month", "Total", "Transactions"],
            rows.slice(0, 24).map((r) => [String(r.month), `$${String(r.total)}`, String(r.count)])
          )
        : wantsByDescription
          ? toGfmTable(
              ["Description", "Total", "Transactions"],
              rows
                .slice(0, 24)
                .map((r) => [String(r.description ?? "(unknown)"), `$${String(r.total)}`, String(r.count)])
            )
        : wantsMerchantBank
          ? toGfmTable(
              ["Merchant", "Total", "Transactions"],
              rows
                .slice(0, 24)
                .map((r) => [String(r.merchant ?? "(unknown)"), `$${String(r.total)}`, String(r.count)])
            )
          : toGfmTable(
              ["Category", "Total", "Transactions"],
              rows
                .slice(0, 24)
                .map((r) => [String(r.category ?? "Uncategorized"), `$${String(r.total)}`, String(r.count)])
            );

  return SpecialistAgentResponseSchema.parse({
    kind: "finance",
    answer_draft: [
      `${isIncomeLike ? "Income/deposits" : "Spend/withdrawals"} for ${getEntityLabel()} in ${range.label}: $${sumResult.total} (${sumResult.count} Transactions).`,
      table ? `\n\n${table}` : "",
    ].join(""),
    questions_for_user: [],
    assumptions: [],
    tool_calls: [],
    citations: [],
    confidence: sumResult.count === 0 ? "low" : "medium",
    chart_payload: chartPayload ?? undefined,
  });
}


