import "server-only";

import type { Session } from "next-auth";
import { z } from "zod";
import {
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
    textLower.includes("descriptions") ||
    textLower.includes("description") ||
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
  const entity = inferEntity(qLower, parsed.entity_hint);

  // Only infer category + presentation intent from the user's actual message,
  // not from appended context (which may contain misleading tokens like "gas"/"fuel").
  const category = inferCategory(mainLower);
  const list = wantsList(mainLower);

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
    const hasPersonal = summary.some((e) => e.entityKind === "personal");
    const options = [
      ...(hasPersonal ? ["Personal"] : []),
      ...Array.from(new Set(businessNames)).sort((a, b) => a.localeCompare(b)),
    ];
    if (options.length > 1) {
      return SpecialistAgentResponseSchema.parse({
        kind: "finance",
        answer_draft: "",
        questions_for_user: [`Is this Personal, or which business? (${options.join(", ")})`],
        assumptions: [],
        tool_calls: [],
        citations: [],
        confidence: "low",
      });
    }
    if (options.length === 1 && options[0] === "Personal") {
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

  const wantsMerchant = mainLower.includes("merchant") || mainLower.includes("merchants");
  const categoryForFilters =
    category ?? (wantsMerchant && contextText ? inferCategoryFromContext(contextText) : null);

  const baseFilters = {
    ...(entity.kind === "personal"
      ? { entity_kind: "personal" as const }
      : { entity_kind: "business" as const, entity_name: entity.name ?? "" }),
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

  // For cc statements we treat "spend" as charges; try positive first, then negatives.
  if (docType === "cc_statement") {
    const topN = wantsMerchant ? inferTopN(mainLower) : null;
    if (list) {
      const pos = await financeList({
        userId: session.user.id,
        projectId: parsed.projectId,
        documentType: "cc_statement",
        filters: { ...baseFilters, amount_min: 0.01 },
      });
      const posRows = pos.query_type === "list" ? pos.rows : [];
      const neg =
        posRows.length === 0
          ? await financeList({
              userId: session.user.id,
              projectId: parsed.projectId,
              documentType: "cc_statement",
              filters: { ...baseFilters, amount_max: -0.01 },
            })
          : null;
      const rows = (neg && neg.query_type === "list" ? neg.rows : posRows) as Array<{
        txnDate: string;
        description: string | null;
        merchant: string | null;
        category: string | null;
        amount: string;
      }>;
      const negAmounts = Boolean(neg && neg.query_type === "list" && neg.rows.length > 0);

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

    const sumPos = (await financeSum({
      userId: session.user.id,
      projectId: parsed.projectId,
      documentType: "cc_statement",
      filters: { ...baseFilters, amount_min: 0.01 },
    })) as { total: string; count: number };
    const sumNeg =
      sumPos.count === 0
        ? ((await financeSum({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType: "cc_statement",
            filters: { ...baseFilters, amount_max: -0.01 },
          })) as { total: string; count: number })
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
          answer_draft: `Spend on ${entity.kind === "personal" ? "Personal" : entity.name} (${category}) in ${range.label}: $${bankSum.total} (${count} txns).`,
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

    const grouped = qLower.includes("by month")
      ? await financeGroupByMonth({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "cc_statement",
          filters: { ...baseFilters, ...(sumNeg && sumNeg.count > 0 ? { amount_max: -0.01 } : { amount_min: 0.01 }) },
        })
      : wantsMerchant
        ? await financeGroupByMerchant({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType: "cc_statement",
            filters: { ...baseFilters, ...(sumNeg && sumNeg.count > 0 ? { amount_max: -0.01 } : { amount_min: 0.01 }) },
          })
        : qLower.includes("by category") || category
          ? await financeGroupByCategory({
              userId: session.user.id,
              projectId: parsed.projectId,
              documentType: "cc_statement",
              filters: { ...baseFilters, ...(sumNeg && sumNeg.count > 0 ? { amount_max: -0.01 } : { amount_min: 0.01 }) },
            })
          : await financeGroupByMerchant({
              userId: session.user.id,
              projectId: parsed.projectId,
              documentType: "cc_statement",
              filters: { ...baseFilters, ...(sumNeg && sumNeg.count > 0 ? { amount_max: -0.01 } : { amount_min: 0.01 }) },
            });

    const rows = Array.isArray((grouped as any).rows) ? ((grouped as any).rows as any[]) : [];
    const table = (() => {
      if (rows.length === 0) return "";
      if (qLower.includes("by month")) {
        return toGfmTable(
          ["Month", "Total", "Txns"],
          rows.slice(0, 24).map((r) => [String(r.month), `$${String(r.total).replace(/^-/, "")}`, String(r.count)])
        );
      }
      if (qLower.includes("by category") || category) {
        return toGfmTable(
          ["Category", "Total", "Txns"],
          rows.slice(0, 24).map((r) => [String(r.category ?? "Uncategorized"), `$${String(r.total).replace(/^-/, "")}`, String(r.count)])
        );
      }
      if (wantsMerchant && typeof topN === "number") {
        return toGfmTable(
          ["Merchant", "Total", "Txns"],
          rows.slice(0, topN).map((r) => [
            String(r.merchant ?? "(unknown)"),
            `$${String(r.total).replace(/^-/, "")}`,
            String(r.count),
          ])
        );
      }
      return toGfmTable(
        ["Merchant", "Total", "Txns"],
        rows.slice(0, 24).map((r) => [String(r.merchant ?? "(unknown)"), `$${String(r.total).replace(/^-/, "")}`, String(r.count)])
      );
    })();

    return SpecialistAgentResponseSchema.parse({
      kind: "finance",
      answer_draft: [
        `Spend on ${entity.kind === "personal" ? "Personal" : entity.name}${category ? ` (${category})` : ""} in ${range.label}: $${total}${signNote} (${used.count} txns).`,
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
    });
  }

  // Bank statement: treat spend as withdrawals (amount < 0) unless user is asking income/deposits.
  const isIncomeLike = qLower.includes("income") || qLower.includes("deposit") || qLower.includes("deposits") || qLower.includes("revenue");
  const amountFilter = isIncomeLike ? { amount_min: 0.01 } : { amount_max: -0.01 };

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
        answer_draft: `Spend on ${entity.kind === "personal" ? "Personal" : entity.name} (${category}) in ${range.label}: $${ccSum.total} (${ccSum.count} txns).`,
        questions_for_user: [],
        assumptions: ["Matched category against cc_statement transactions (charges only)."],
        tool_calls: [],
        citations: [],
        confidence: "medium",
      });
    }
  }

  if (list) {
    const out = await financeList({
      userId: session.user.id,
      projectId: parsed.projectId,
      documentType: "bank_statement",
      filters: { ...baseFilters, ...amountFilter },
    });
    const rows = (out.query_type === "list" ? out.rows : []) as Array<{
      txnDate: string;
      description: string | null;
      category: string | null;
      amount: string;
    }>;
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

  const sum = await financeSum({
    userId: session.user.id,
    projectId: parsed.projectId,
    documentType: "bank_statement",
    filters: { ...baseFilters, ...amountFilter },
  });

  const grouped = qLower.includes("by category")
    ? await financeGroupByCategory({
        userId: session.user.id,
        projectId: parsed.projectId,
        documentType: "bank_statement",
        filters: { ...baseFilters, ...amountFilter },
      })
    : qLower.includes("by month")
      ? await financeGroupByMonth({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "bank_statement",
          filters: { ...baseFilters, ...amountFilter },
        })
      : null;

  const rows = grouped && Array.isArray((grouped as any).rows) ? ((grouped as any).rows as any[]) : [];
  const table =
    rows.length === 0
      ? ""
      : qLower.includes("by month")
        ? toGfmTable(
            ["Month", "Total", "Txns"],
            rows.slice(0, 24).map((r) => [String(r.month), `$${String(r.total)}`, String(r.count)])
          )
        : toGfmTable(
            ["Category", "Total", "Txns"],
            rows.slice(0, 24).map((r) => [String(r.category ?? "Uncategorized"), `$${String(r.total)}`, String(r.count)])
          );

  return SpecialistAgentResponseSchema.parse({
    kind: "finance",
    answer_draft: [
      `${isIncomeLike ? "Income/deposits" : "Spend/withdrawals"} for ${entity.kind === "personal" ? "Personal" : entity.name} in ${range.label}: $${sum.total} (${sum.count} txns).`,
      table ? `\n\n${table}` : "",
    ].join(""),
    questions_for_user: [],
    assumptions: [],
    tool_calls: [],
    citations: [],
    confidence: sum.count === 0 ? "low" : "medium",
  });
}


