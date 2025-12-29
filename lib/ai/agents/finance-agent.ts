import { generateText, tool } from "ai";
import type { Session } from "next-auth";
import { z } from "zod";
import { myProvider } from "@/lib/ai/providers";
import { financeQuery } from "@/lib/ai/tools/finance-query";
import {
  financeGroupByMonth,
  financeGroupByMerchant,
  financeList,
  financeSum,
  getProjectDocsByProjectId,
  getProjectEntitySummaryForUser,
} from "@/lib/db/queries";
import {
  SpecialistAgentResponseSchema,
  type SpecialistAgentResponse,
} from "@/lib/ai/agents/types";

const FinanceAgentInputSchema = z.object({
  question: z.string().min(1).max(4000),
  // Optional hints the frontline can pass
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

  const model = myProvider.languageModel("chat-model-reasoning");
  const debug = process.env.DEBUG_FINANCE_AGENT === "1";
  const log = (event: string, data: Record<string, unknown>) => {
    if (!debug) return;
    console.log(`[FinanceAgent] ${event}`, data);
  };
  const logAlwaysInDev = (event: string, data: Record<string, unknown>) => {
    if (debug || process.env.NODE_ENV !== "production") {
      console.log(`[FinanceAgent] ${event}`, data);
    }
  };

  const inferYearFromText = (text: string): number | null => {
    const match = text.match(/\b(19\d{2}|20\d{2})\b/);
    if (!match) return null;
    const year = Number(match[1]);
    if (!Number.isFinite(year) || year < 1900 || year > 2200) return null;
    return year;
  };

  const inferBusinessNameFromText = (text: string, businessNames: string[]): string | null => {
    const q = text.toLowerCase();
    let best: string | null = null;
    for (const name of businessNames) {
      const needle = name.toLowerCase();
      if (!needle) continue;
      if (!q.includes(needle)) continue;
      if (!best || needle.length > best.toLowerCase().length) best = name;
    }
    return best;
  };

  const listBusinessEntityNames = async (): Promise<string[]> => {
    if (!parsed.projectId) return [];
    const rows = await getProjectEntitySummaryForUser({
      userId: session.user.id,
      projectId: parsed.projectId,
    });
    const names: string[] = [];
    for (const row of rows) {
      if (row.entityKind !== "business") continue;
      if (typeof row.entityName !== "string") continue;
      const trimmed = row.entityName.trim();
      if (trimmed.length > 0) names.push(trimmed);
    }
    return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
  };

  const parseRollingWindowDays = (text: string): number | null => {
    const preset = text.match(
      /\b(?:last|past)\s+(week|month|quarter|year)\b|\b(?:last)\s+(90)\s+days\b/i
    );
    if (preset) {
      const unit = preset[1]?.toLowerCase();
      if (unit === "week") return 7;
      if (unit === "month") return 30;
      if (unit === "quarter") return 90;
      if (unit === "year") return 365;
      if (preset[2] === "90") return 90;
    }

    const m = text.match(/\b(?:last|past)\s+(\d{1,4})\s*(day|days|week|weeks|month|months|year|years)\b/i);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    const unit = m[2].toLowerCase();
    if (unit.startsWith("day")) return n;
    if (unit.startsWith("week")) return n * 7;
    if (unit.startsWith("month")) return n * 30;
    if (unit.startsWith("year")) return n * 365;
    return null;
  };

  const parseRollingWindowMonths = (text: string): number | null => {
    const m = text.match(/\b(?:last|past)\s+(\d{1,3})\s*months?\b/i);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  };

  const monthStartYmdUtc = (d: Date): string => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}-01`;
  };

  const addMonthsYmdUtc = (ymd: string, monthsToAdd: number): string => {
    const [yStr, mStr] = ymd.split("-");
    const y = Number(yStr);
    const m = Number(mStr);
    if (!Number.isFinite(y) || !Number.isFinite(m)) return ymd;
    const base = new Date(Date.UTC(y, m - 1, 1));
    base.setUTCMonth(base.getUTCMonth() + monthsToAdd);
    return monthStartYmdUtc(base);
  };

  const enumerateMonths = (startYmd: string, endYmd: string): string[] => {
    const out: string[] = [];
    let cur = startYmd;
    // Guard against infinite loops on malformed input
    for (let i = 0; i < 120; i += 1) {
      if (cur >= endYmd) break;
      out.push(cur.slice(0, 7));
      cur = addMonthsYmdUtc(cur, 1);
    }
    return out;
  };

  const system = `You are FinanceAgent.

You MUST return ONLY valid JSON that matches this schema:
${SpecialistAgentResponseSchema.toString()}

Rules:
- Use financeQuery for any totals/sums/aggregations. Never compute math yourself.
- Prefer bank_statement deposits for income-like questions (made/brought in/income/deposits/revenue), with filters.amount_min > 0.
- CRITICAL: For "income" or "revenue" questions, you MUST set filters.exclude_categories=['transfer', 'credit card payment'] unless the user asks for transfers.
- For "spend"/"spent"/"expenses"/"charges" questions:
  - You MUST run financeQuery (do not say you can't retrieve data unless financeQuery returns an error).
  - If the user did not specify which account(s) / statement(s) to include, ask a clarifying question listing which business statements exist.
- If the user asks about invoice revenue, use document_type='invoice'.
- If you need to know what entities exist in the project, call projectEntitySummary.
- If entity_hint is provided, use filters.entity_name/entity_kind accordingly.
- If time_hint is provided, you MUST set time_window to match it unless the user explicitly asks for a different time range.
- If the user does NOT specify an entity and no entity_hint is provided:
  - Call projectEntitySummary.
  - If there is more than one plausible entity, ASK a clarifying question (set questions_for_user) and include the available entity names.
  - Do NOT guess or merge entities.
- If bank_statement deposits return 0 rows and the user did not explicitly ask invoice revenue, set fallback_to_invoice_if_empty=true.
- Keep answer_draft concise; frontline will present final answer.
`;

  const prompt = `User question:
${parsed.question}

Hints:
${JSON.stringify({ entity_hint: parsed.entity_hint ?? null, time_hint: parsed.time_hint ?? null }, null, 2)}

Return JSON only.`;

  let lastToolCalls: unknown = null;
  let lastToolResults: unknown = null;

  // Deterministic shortcuts for spend/income queries that can be answered directly from Postgres.
  // This avoids the LLM choosing a bad financeQuery filter combo (amount_max<=0, entity mismatch, etc.).
  try {
    const q = parsed.question.toLowerCase();
    const isIncomeLike =
      q.includes("income") ||
      q.includes("revenue") ||
      q.includes("deposits") ||
      q.includes("bring in") ||
      q.includes("made");
    const monthFromText = (() => {
      const byName: Record<string, number> = {
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
      for (const [k, v] of Object.entries(byName)) {
        if (q.includes(k)) return v;
      }
      return null;
    })();
    const wantsSummary =
      q.includes("summarize") ||
      q.includes("breakdown") ||
      q.includes("what did i spend") ||
      q.includes("what i spent") ||
      q.includes("what did we spend") ||
      q.includes("where did i spend");
    const isSpendLike =
      q.includes("spend") ||
      q.includes("spent") ||
      q.includes("spending") ||
      q.includes("expense") ||
      q.includes("expenses") ||
      q.includes("charge") ||
      q.includes("charges");
    const wantsCc =
      q.includes("credit card") ||
      q.includes("card") ||
      q.includes("amex") ||
      q.includes("american express") ||
      q.includes("visa") ||
      q.includes("mastercard");
    const wantsPersonal =
      q.includes("personal") || parsed.entity_hint?.entity_kind === "personal";
    const wantsBusiness = q.includes("business") || parsed.entity_hint?.entity_kind === "business";

    // Personal income over a rolling window (e.g. "last 90 days", "past 3 weeks"): sum bank_statement deposits.
    const rollingDays = parseRollingWindowDays(parsed.question);
    if (parsed.projectId && wantsPersonal && isIncomeLike && typeof rollingDays === "number") {
      const dayMs = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const start = new Date(now - rollingDays * dayMs);
      const end = new Date(now + dayMs); // exclusive end = tomorrow (UTC)
      const date_start = start.toISOString().slice(0, 10);
      const date_end = end.toISOString().slice(0, 10);

      const docs = await getProjectDocsByProjectId({ projectId: parsed.projectId });
      const personalBankDocs = docs
        .filter((d) => d.documentType === "bank_statement")
        .filter((d) => {
          if (d.entityKind === "personal") return true;
          const name = typeof d.entityName === "string" ? d.entityName.trim().toLowerCase() : "";
          return name === "personal";
        });
      const docIds = personalBankDocs.map((d) => d.id);

      logAlwaysInDev("deterministic_personal_rolling_income_candidates", {
        rollingDays,
        date_start,
        date_end,
        docCount: docIds.length,
        docs: personalBankDocs.slice(0, 10).map((d) => ({ id: d.id, filename: d.filename })),
      });

      if (docIds.length === 0) {
        const anyBank = docs
          .filter((d) => d.documentType === "bank_statement")
          .slice(0, 12)
          .map((d) => {
            const entityLabel =
              d.entityKind === "business" && typeof d.entityName === "string" && d.entityName.trim()
                ? `Business:${d.entityName.trim()}`
                : d.entityKind === "personal"
                  ? "Personal"
                  : "Unassigned";
            return `${d.filename} (${entityLabel})`;
          });
        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: "",
          questions_for_user: [
            anyBank.length > 0
              ? `I didn’t find any bank statements tagged Personal. Which statement should I use for your personal deposits in the last ${rollingDays} days? (${anyBank.join("; ")})`
              : "I don’t see any bank statements in this project yet.",
          ],
          assumptions: [],
          tool_calls: [],
          citations: [],
          confidence: "low",
        });
      }

      const sum = await financeSum({
        userId: session.user.id,
        projectId: parsed.projectId,
        documentType: "bank_statement",
        filters: {
          doc_ids: docIds,
          date_start,
          date_end,
          amount_min: 0.01,
          exclude_categories: ["transfer", "credit card payment"],
        },
      });

      const list = await financeList({
        userId: session.user.id,
        projectId: parsed.projectId,
        documentType: "bank_statement",
        filters: {
          doc_ids: docIds,
          date_start,
          date_end,
          amount_min: 0.01,
          exclude_categories: ["transfer", "credit card payment"],
        },
      });

      logAlwaysInDev("deterministic_personal_rolling_income_result", {
        rollingDays,
        date_start,
        date_end,
        total: sum.total,
        count: sum.count,
        listCount: list.query_type === "list" ? list.rows.length : 0,
      });

      const isTxnRow = (
        row: (typeof list.rows)[number]
      ): row is (typeof list.rows)[number] & {
        txnDate: string;
        description: string | null;
        amount: string;
      } => {
        if (typeof row !== "object" || row === null) return false;
        const r = row as Record<string, unknown>;
        return (
          typeof r.txnDate === "string" &&
          typeof r.amount === "string" &&
          (typeof r.description === "string" || r.description === null)
        );
      };

      const maxRowsToShow = 60;
      const allTxnRows = list.query_type === "list" ? list.rows.filter(isTxnRow) : [];
      const shown = allTxnRows.slice(0, maxRowsToShow);
      const breakdownLines =
        shown.length > 0
          ? shown
              .map((r) => {
                const desc = typeof r.description === "string" ? r.description.trim() : "";
                const clipped = desc.length > 140 ? `${desc.slice(0, 140)}…` : desc;
                return `${r.txnDate} • ${clipped || "(no description)"} • $${r.amount}`;
              })
              .join("\n")
          : "";

      return SpecialistAgentResponseSchema.parse({
        kind: "finance",
        answer_draft:
          sum.count === 0
            ? `Personal deposits in the last ${rollingDays} days (${date_start} to ${date_end}): ${sum.total} (rows: ${sum.count}).`
            : [
                `Personal deposits in the last ${rollingDays} days (${date_start} to ${date_end}): $${sum.total}`,
                `Number of deposits: ${sum.count}`,
                "",
                "By transaction (date • description • amount):",
                breakdownLines,
                allTxnRows.length > maxRowsToShow
                  ? `\n(Showing ${maxRowsToShow} of ${allTxnRows.length} matching deposits.)`
                  : "",
              ]
                .filter((s) => s.length > 0)
                .join("\n"),
        questions_for_user:
          sum.count === 0
            ? [
                "I found 0 matching deposits in that window. Are your personal bank statements tagged Personal, or are they unassigned?",
              ]
            : [],
        assumptions: [
          "Income is computed as bank-statement deposits (amount > 0), excluding transfers and credit-card payments.",
          "The date range is computed in UTC; date_end is exclusive.",
        ],
        tool_calls: [
          {
            toolName: "financeSum",
            input: {
              document_type: "bank_statement",
              doc_ids: docIds,
              date_start,
              date_end,
              amount_min: 0.01,
              exclude_categories: ["transfer", "credit card payment"],
            },
            output: sum,
          },
          {
            toolName: "financeList",
            input: {
              document_type: "bank_statement",
              doc_ids: docIds,
              date_start,
              date_end,
              amount_min: 0.01,
              exclude_categories: ["transfer", "credit card payment"],
            },
            output: list,
          },
        ],
        citations: [],
        confidence: sum.count === 0 ? "low" : "medium",
      });
    }

    // Business income over a rolling window (e.g. "last 90 days", "past 3 weeks"): sum bank_statement deposits.
    if (parsed.projectId && wantsBusiness && isIncomeLike && typeof rollingDays === "number") {
      const businessNames = await listBusinessEntityNames();
      const hintedName = parsed.entity_hint?.entity_name?.trim();
      const inferredName = inferBusinessNameFromText(parsed.question, businessNames);
      const entityName =
        hintedName && hintedName.length > 0
          ? hintedName
          : inferredName
            ? inferredName
            : businessNames.length === 1
              ? businessNames[0]
              : null;

      if (!entityName) {
        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: "",
          questions_for_user: [
            businessNames.length > 0
              ? `Which business should I use? (${businessNames.join(", ")})`
              : "Which business should I use?",
          ],
          assumptions: [],
          tool_calls: [],
          citations: [],
          confidence: "low",
        });
      }

      const dayMs = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const start = new Date(now - rollingDays * dayMs);
      const end = new Date(now + dayMs); // exclusive end = tomorrow (UTC)
      const date_start = start.toISOString().slice(0, 10);
      const date_end = end.toISOString().slice(0, 10);

      const docs = await getProjectDocsByProjectId({ projectId: parsed.projectId });
      const businessBankDocs = docs
        .filter((d) => d.documentType === "bank_statement")
        .filter((d) => d.entityKind === "business")
        .filter((d) => {
          const name = typeof d.entityName === "string" ? d.entityName.trim() : "";
          return name.length > 0 && name.toLowerCase() === entityName.toLowerCase();
        });
      const docIds = businessBankDocs.map((d) => d.id);

      logAlwaysInDev("deterministic_business_rolling_income_candidates", {
        entityName,
        rollingDays,
        date_start,
        date_end,
        docCount: docIds.length,
        docs: businessBankDocs.slice(0, 10).map((d) => ({ id: d.id, filename: d.filename })),
      });

      if (docIds.length === 0) {
        const anyBusinessBank = docs
          .filter((d) => d.documentType === "bank_statement")
          .filter((d) => d.entityKind === "business")
          .slice(0, 12)
          .map((d) => `${d.filename} (${typeof d.entityName === "string" ? d.entityName : "Business"})`);

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: "",
          questions_for_user: [
            anyBusinessBank.length > 0
              ? `I didn’t find any business bank statements tagged "${entityName}". Which statement should I use? (${anyBusinessBank.join("; ")})`
              : `I don’t see any business bank statements tagged "${entityName}" in this project yet.`,
          ],
          assumptions: [],
          tool_calls: [],
          citations: [],
          confidence: "low",
        });
      }

      const sum = await financeSum({
        userId: session.user.id,
        projectId: parsed.projectId,
        documentType: "bank_statement",
        filters: {
          doc_ids: docIds,
          date_start,
          date_end,
          amount_min: 0.01,
          exclude_categories: ["transfer", "credit card payment"],
        },
      });

      const list = await financeList({
        userId: session.user.id,
        projectId: parsed.projectId,
        documentType: "bank_statement",
        filters: {
          doc_ids: docIds,
          date_start,
          date_end,
          amount_min: 0.01,
          exclude_categories: ["transfer", "credit card payment"],
        },
      });

      const isTxnRow = (
        row: (typeof list.rows)[number]
      ): row is (typeof list.rows)[number] & {
        txnDate: string;
        description: string | null;
        amount: string;
      } => {
        if (typeof row !== "object" || row === null) return false;
        const r = row as Record<string, unknown>;
        return (
          typeof r.txnDate === "string" &&
          typeof r.amount === "string" &&
          (typeof r.description === "string" || r.description === null)
        );
      };

      const maxRowsToShow = 60;
      const allTxnRows = list.query_type === "list" ? list.rows.filter(isTxnRow) : [];
      const shown = allTxnRows.slice(0, maxRowsToShow);
      const breakdownLines =
        shown.length > 0
          ? shown
              .map((r) => {
                const desc = typeof r.description === "string" ? r.description.trim() : "";
                const clipped = desc.length > 140 ? `${desc.slice(0, 140)}…` : desc;
                return `${r.txnDate} • ${clipped || "(no description)"} • $${r.amount}`;
              })
              .join("\n")
          : "";

      logAlwaysInDev("deterministic_business_rolling_income_result", {
        entityName,
        rollingDays,
        date_start,
        date_end,
        total: sum.total,
        count: sum.count,
        listCount: list.query_type === "list" ? list.rows.length : 0,
      });

      return SpecialistAgentResponseSchema.parse({
        kind: "finance",
        answer_draft:
          sum.count === 0
            ? `Business deposits for ${entityName} in the last ${rollingDays} days (${date_start} to ${date_end}): ${sum.total} (rows: ${sum.count}).`
            : [
                `Business deposits for ${entityName} in the last ${rollingDays} days (${date_start} to ${date_end}): $${sum.total}`,
                `Number of deposits: ${sum.count}`,
                "",
                "By transaction (date • description • amount):",
                breakdownLines,
                allTxnRows.length > maxRowsToShow
                  ? `\n(Showing ${maxRowsToShow} of ${allTxnRows.length} matching deposits.)`
                  : "",
              ]
                .filter((s) => s.length > 0)
                .join("\n"),
        questions_for_user:
          sum.count === 0
            ? ["I found 0 matching deposits in that window. Is the business bank statement tagged correctly?"]
            : [],
        assumptions: [
          "Income is computed as bank-statement deposits (amount > 0), excluding transfers and credit-card payments.",
          "The date range is computed in UTC; date_end is exclusive.",
        ],
        tool_calls: [
          {
            toolName: "financeSum",
            input: {
              document_type: "bank_statement",
              doc_ids: docIds,
              date_start,
              date_end,
              amount_min: 0.01,
              exclude_categories: ["transfer", "credit card payment"],
            },
            output: sum,
          },
          {
            toolName: "financeList",
            input: {
              document_type: "bank_statement",
              doc_ids: docIds,
              date_start,
              date_end,
              amount_min: 0.01,
              exclude_categories: ["transfer", "credit card payment"],
            },
            output: list,
          },
        ],
        citations: [],
        confidence: sum.count === 0 ? "low" : "medium",
      });
    }

    // Business income for a specific month: sum bank_statement deposits for that calendar month.
    if (isIncomeLike && wantsBusiness && monthFromText && parsed.projectId) {
      const businessNames = await listBusinessEntityNames();
      const year =
        parsed.time_hint?.kind === "year"
          ? parsed.time_hint.year ?? null
          : inferYearFromText(parsed.question) ?? new Date().getUTCFullYear();
      const hintedName = parsed.entity_hint?.entity_name?.trim();
      const inferredName = inferBusinessNameFromText(parsed.question, businessNames);
      const entityName =
        hintedName && hintedName.length > 0
          ? hintedName
          : inferredName
            ? inferredName
            : businessNames.length === 1
              ? businessNames[0]
              : null;

      if (!entityName) {
        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: "",
          questions_for_user: [
            businessNames.length > 0
              ? `Which business should I use? (${businessNames.join(", ")})`
              : "Which business should I use? (I don't see any business entities tagged yet.)",
          ],
          assumptions: [],
          tool_calls: [],
          citations: [],
          confidence: "low",
        });
      }

      if (typeof year === "number" && Number.isFinite(year)) {
        const mm = String(monthFromText).padStart(2, "0");
        const start = `${year}-${mm}-01`;
        const endYear = monthFromText === 12 ? year + 1 : year;
        const endMonth = monthFromText === 12 ? 1 : monthFromText + 1;
        const endMm = String(endMonth).padStart(2, "0");
        const end = `${endYear}-${endMm}-01`;

        const sum = await financeSum({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "bank_statement",
          filters: {
            entity_kind: "business",
            entity_name: entityName,
            amount_min: 0.01,
            exclude_categories: ["transfer", "credit card payment"],
            date_start: start,
            date_end: end,
          },
        });

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: `Business income deposits for ${entityName} in ${year}-${mm}: ${sum.total} (rows: ${sum.count}).`,
          questions_for_user:
            sum.count === 0
              ? [`I found 0 business deposits for ${entityName} in ${year}-${mm}. Is your business bank statement tagged to "${entityName}"?`]
              : [],
          assumptions: [
            "Income is computed as bank-statement deposits (amount > 0), excluding transfers and credit-card payments.",
          ],
          tool_calls: [
            {
              toolName: "financeSum",
              input: {
                document_type: "bank_statement",
                entity_kind: "business",
                entity_name: entityName,
                date_start: start,
                date_end: end,
                amount_min: 0.01,
                exclude_categories: ["transfer", "credit card payment"],
              },
              output: sum,
            },
          ],
          citations: [],
          confidence: sum.count === 0 ? "low" : "medium",
        });
      }
    }

    // Personal spend summary: use transaction description via group_by_merchant (merchant=description for statements).
    if (wantsSummary && isSpendLike && wantsPersonal && parsed.projectId && !monthFromText) {
      const year =
        parsed.time_hint?.kind === "year"
          ? parsed.time_hint.year ?? null
          : inferYearFromText(parsed.question) ?? new Date().getUTCFullYear();

      if (typeof year === "number" && Number.isFinite(year)) {
        const docs = await getProjectDocsByProjectId({ projectId: parsed.projectId });
        const personalCcDocs = docs
          .filter((d) => d.documentType === "cc_statement")
          .filter((d) => d.entityKind === "personal");

        const docIds = personalCcDocs.map((d) => d.id);
        if (docIds.length === 0) {
          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: "",
            questions_for_user: [
              `I don’t see any personal credit-card statements tagged Personal yet. Which statement should I use to summarize ${year} personal spend?`,
            ],
            assumptions: [],
            tool_calls: [],
            citations: [],
            confidence: "low",
          });
        }

        const total = await financeSum({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "cc_statement",
          filters: {
            doc_ids: docIds,
            date_start: `${year}-01-01`,
            date_end: `${year + 1}-01-01`,
            amount_min: 0.01,
          },
        });

        const top = await financeGroupByMerchant({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "cc_statement",
          filters: {
            doc_ids: docIds,
            date_start: `${year}-01-01`,
            date_end: `${year + 1}-01-01`,
            amount_min: 0.01,
          },
        });

        const rows = Array.isArray(top.rows) ? top.rows : [];
        const topRows = rows.slice(0, 12);
        const lines = topRows.map((r) => {
          const merchant = typeof r.merchant === "string" && r.merchant.trim().length > 0 ? r.merchant.trim() : "(unknown)";
          return `- ${merchant}: ${r.total} (${r.count} txns)`;
        });

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: [
            `Personal Amex spend summary for ${year} (charges only):`,
            `- Total: ${total.total}`,
            `- Transactions: ${total.count}`,
            "",
            "Top descriptions by spend:",
            ...lines,
          ].join("\n"),
          questions_for_user: [],
          assumptions: [
            "Spend is computed as positive cc_statement amounts (amount > 0).",
            "Descriptions are taken from the transaction description field and grouped verbatim.",
          ],
          tool_calls: [
            {
              toolName: "financeSum",
              input: { document_type: "cc_statement", doc_ids: docIds, year, amount_min: 0.01 },
              output: total,
            },
            {
              toolName: "financeGroupByMerchant",
              input: { document_type: "cc_statement", doc_ids: docIds, year, amount_min: 0.01 },
              output: top,
            },
          ],
          citations: [],
          confidence: total.count === 0 ? "low" : "medium",
        });
      }
    }

    // Monthly spend on Amex for the last N full calendar months (personal).
    if (
      parsed.projectId &&
      wantsPersonal &&
      isSpendLike &&
      wantsCc &&
      (q.includes("each month") || q.includes("month by month")) &&
      (q.includes("amex") || q.includes("american express"))
    ) {
      const months = parseRollingWindowMonths(parsed.question);
      if (typeof months === "number") {
        const safeMonths = Math.min(Math.max(months, 1), 24);
        const now = new Date();
        const date_end = monthStartYmdUtc(now); // first day of current month (UTC) => last N *full* months
        const date_start = addMonthsYmdUtc(date_end, -safeMonths);

        const docs = await getProjectDocsByProjectId({ projectId: parsed.projectId });
        const personalAmexDocs = docs
          .filter((d) => d.documentType === "cc_statement")
          .filter((d) => d.entityKind === "personal")
          .filter((d) => d.filename.toLowerCase().includes("amex"));

        const docIds = personalAmexDocs.map((d) => d.id);
        if (docIds.length === 0) {
          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: "",
            questions_for_user: [
              `I don’t see any personal Amex credit-card statements tagged Personal yet. Which statement should I use to compute the last ${safeMonths} months of spend?`,
            ],
            assumptions: [],
            tool_calls: [],
            citations: [],
            confidence: "low",
          });
        }

        const grouped = await financeGroupByMonth({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "cc_statement",
          filters: {
            doc_ids: docIds,
            date_start,
            date_end,
            amount_min: 0.01,
          },
        });

        const wantMonths = enumerateMonths(date_start, date_end);
        const totalsByMonth = new Map<string, string>();
        if (Array.isArray(grouped.rows)) {
          for (const r of grouped.rows) {
            if (!r || typeof r !== "object") continue;
            const row = r as { month?: string; total?: string };
            if (typeof row.month === "string" && typeof row.total === "string") {
              totalsByMonth.set(row.month, row.total);
            }
          }
        }

        const lines = wantMonths.map((m) => `${m}: $${totalsByMonth.get(m) ?? "0"}`);

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: [
            `Monthly spend on your personal Amex for the last ${safeMonths} full calendar months (${date_start} to ${date_end}):`,
            "",
            ...lines,
          ].join("\n"),
          questions_for_user: [],
          assumptions: ["Spend is computed as positive cc_statement amounts (amount > 0)."],
          tool_calls: [
            {
              toolName: "financeGroupByMonth",
              input: {
                document_type: "cc_statement",
                doc_ids: docIds,
                date_start,
                date_end,
                amount_min: 0.01,
              },
              output: grouped,
            },
          ],
          citations: [],
          confidence: "medium",
        });
      }
    }

    // Credit-card spend for a specific month (e.g. "October 2025"): pick the most relevant statement(s) and sum charges for that month.
    if (
      isSpendLike &&
      wantsCc &&
      (wantsBusiness || wantsPersonal) &&
      parsed.projectId &&
      monthFromText
    ) {
      const year =
        parsed.time_hint?.kind === "year"
          ? parsed.time_hint.year ?? null
          : inferYearFromText(parsed.question) ?? new Date().getUTCFullYear();

      if (typeof year === "number" && Number.isFinite(year)) {
        const mm = String(monthFromText).padStart(2, "0");
        const date_start = `${year}-${mm}-01`;
        const endYear = monthFromText === 12 ? year + 1 : year;
        const endMonth = monthFromText === 12 ? 1 : monthFromText + 1;
        const endMm = String(endMonth).padStart(2, "0");
        const date_end = `${endYear}-${endMm}-01`;

        const docs = await getProjectDocsByProjectId({ projectId: parsed.projectId });
        const ccDocs = docs.filter((d) => d.documentType === "cc_statement");
        const mentionsAmex = q.includes("amex") || q.includes("american express");

        const businessNames = await listBusinessEntityNames();
        const hintedName = parsed.entity_hint?.entity_name?.trim();
        const inferredName = inferBusinessNameFromText(parsed.question, businessNames);
        const entityName =
          hintedName && hintedName.length > 0
            ? hintedName
            : inferredName
              ? inferredName
              : businessNames.length === 1
                ? businessNames[0]
                : null;

        if (wantsBusiness && !entityName) {
          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: "",
            questions_for_user: [
              businessNames.length > 0
                ? `Which business should I use? (${businessNames.join(", ")})`
                : "Which business should I use?",
            ],
            assumptions: [],
            tool_calls: [],
            citations: [],
            confidence: "low",
          });
        }

        const ymdFromMaybeDate = (v: unknown): string | null => {
          if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
          if (v instanceof Date && Number.isFinite(v.getTime())) {
            return v.toISOString().slice(0, 10);
          }
          return null;
        };

        const overlapsMonth = (doc: (typeof ccDocs)[number]): boolean => {
          const ps = ymdFromMaybeDate((doc as any).periodStart);
          const pe = ymdFromMaybeDate((doc as any).periodEnd);
          if (!ps || !pe) return true; // unknown period => keep as candidate
          // overlap([ps, pe), [date_start, date_end)) iff pe > start && ps < end
          return pe > date_start && ps < date_end;
        };

        const baseCandidates = mentionsAmex
          ? (() => {
              const amex = ccDocs.filter((d) => d.filename.toLowerCase().includes("amex"));
              return amex.length > 0 ? amex : ccDocs;
            })()
          : ccDocs;

        const candidates = (() => {
          if (wantsPersonal) {
            return baseCandidates.filter((d) => d.entityKind === "personal").filter(overlapsMonth);
          }
          if (wantsBusiness) {
            const target = String(entityName ?? "").trim().toLowerCase();
            const tagged = baseCandidates
              .filter((d) => d.entityKind === "business")
              .filter((d) => {
                const name = typeof d.entityName === "string" ? d.entityName.trim().toLowerCase() : "";
                return name.length > 0 && name === target;
              })
              .filter(overlapsMonth);
            if (tagged.length > 0) return tagged;
            // If nothing explicitly tagged to this business, fall back to non-personal docs that overlap.
            const nonPersonal = baseCandidates.filter((d) => d.entityKind !== "personal").filter(overlapsMonth);
            return nonPersonal;
          }
          return baseCandidates.filter(overlapsMonth);
        })();

        logAlwaysInDev("deterministic_month_spend_candidates", {
          wantsPersonal,
          wantsBusiness,
          mentionsAmex,
          entityName: wantsBusiness ? entityName : null,
          month: `${year}-${mm}`,
          candidates: candidates.slice(0, 10).map((d) => ({
            id: d.id,
            filename: d.filename,
            entityKind: d.entityKind,
            entityName: d.entityName,
            periodStart: (d as any).periodStart,
            periodEnd: (d as any).periodEnd,
          })),
        });

        if (candidates.length === 0) {
          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: "",
            questions_for_user: [
              wantsBusiness && entityName
                ? `I don’t see any credit-card statements for ${entityName} that match ${year}-${mm}. Which statement should I use?`
                : `I don’t see any personal credit-card statements that match ${year}-${mm}. Which statement should I use?`,
            ],
            assumptions: [],
            tool_calls: [],
            citations: [],
            confidence: "low",
          });
        }

        if (candidates.length > 1) {
          const options = candidates.slice(0, 10).map((d) => d.filename);
          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: "",
            questions_for_user: [
              wantsBusiness && entityName
                ? `Which ${entityName} credit-card statement should I use for ${year}-${mm} spend? (${options.join(", ")})`
                : `Which personal credit-card statement should I use for ${year}-${mm} spend? (${options.join(", ")})`,
            ],
            assumptions: [],
            tool_calls: [],
            citations: [],
            confidence: "low",
          });
        }

        const doc = candidates[0];
        const absDecimalString = (s: string): string => (s.startsWith("-") ? s.slice(1) : s);

        // Prefer positive-charge convention. If 0 rows, fall back to negative-charge convention and present absolute.
        const sumPos = (await financeSum({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "cc_statement",
          filters: {
            doc_ids: [doc.id],
            date_start,
            date_end,
            amount_min: 0.01,
          },
        })) as { total: string; count: number };

        const sumNeg =
          sumPos.count === 0
            ? ((await financeSum({
                userId: session.user.id,
                projectId: parsed.projectId,
                documentType: "cc_statement",
                filters: {
                  doc_ids: [doc.id],
                  date_start,
                  date_end,
                  amount_max: -0.01,
                },
              })) as { total: string; count: number })
            : null;

        const used = sumNeg && sumNeg.count > 0 ? sumNeg : sumPos;
        const total = typeof used.total === "string" ? absDecimalString(used.total) : String(used.total);
        const signNote =
          sumNeg && sumNeg.count > 0
            ? " (note: amounts were stored as negatives; total shown as absolute)"
            : "";

        const breakdownLines = await (async () => {
          try {
            const top = await financeGroupByMerchant({
              userId: session.user.id,
              projectId: parsed.projectId,
              documentType: "cc_statement",
              filters: {
                doc_ids: [doc.id],
                date_start,
                date_end,
                ...(sumNeg && sumNeg.count > 0 ? { amount_max: -0.01 } : { amount_min: 0.01 }),
              },
            });
            const rows = Array.isArray(top.rows) ? top.rows : [];
            if (rows.length === 0) return "";
            const lines = rows.slice(0, 8).map((r) => {
              const merchant =
                typeof r.merchant === "string" && r.merchant.trim().length > 0
                  ? r.merchant.trim()
                  : "(unknown)";
              const amt = typeof r.total === "string" ? absDecimalString(r.total) : String(r.total);
              return `- ${merchant}: $${amt}`;
            });
            return `\n\nTop spending by merchant:\n${lines.join("\n")}`;
          } catch (err) {
            console.warn("FinanceAgent: breakdown shortcut failed", err);
            return "";
          }
        })();

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: wantsBusiness && entityName
            ? `You spent $${total} on ${entityName}${mentionsAmex ? " Amex" : ""} in ${year}-${mm}${signNote}.${breakdownLines}`
            : `You spent $${total} on your personal credit card${mentionsAmex ? " (Amex)" : ""} in ${year}-${mm}${signNote}.${breakdownLines}`,
          questions_for_user: [],
          assumptions: ["Spend is computed from cc_statement transactions for the specified month; transfers/payments are not included unless present as transactions."],
          tool_calls: [
            {
              toolName: "financeSum",
              input: {
                document_type: "cc_statement",
                doc_ids: [doc.id],
                date_start,
                date_end,
                ...(sumNeg && sumNeg.count > 0 ? { amount_max: -0.01 } : { amount_min: 0.01 }),
              },
              output: used,
            },
            {
              toolName: "financeGroupByMerchant",
              input: {
                document_type: "cc_statement",
                doc_ids: [doc.id],
                date_start,
                date_end,
                ...(sumNeg && sumNeg.count > 0 ? { amount_max: -0.01 } : { amount_min: 0.01 }),
              },
              output: { note: "See answer text for summary" },
            },
          ],
          citations: [],
          confidence: used.count === 0 ? "low" : "medium",
        });
      }
    }

    if (isSpendLike && wantsCc && (wantsBusiness || wantsPersonal) && parsed.projectId) {
      const businessNames = await listBusinessEntityNames();
      const year =
        parsed.time_hint?.kind === "year"
          ? parsed.time_hint.year ?? null
          : inferYearFromText(parsed.question) ?? new Date().getUTCFullYear();

      const hintedName = parsed.entity_hint?.entity_name?.trim();
      const inferredName = inferBusinessNameFromText(parsed.question, businessNames);
      const entityName =
        hintedName && hintedName.length > 0
          ? hintedName
          : inferredName
            ? inferredName
            : businessNames.length === 1
              ? businessNames[0]
              : null;

      if (!entityName) {
        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: "",
          questions_for_user: [
            businessNames.length > 0
              ? `Which business should I use? (${businessNames.join(", ")})`
              : "Which business should I use? (I don't see any business entities tagged yet.)",
          ],
          assumptions: [],
          tool_calls: [],
          citations: [],
          confidence: "low",
        });
      }

      const docs = await getProjectDocsByProjectId({ projectId: parsed.projectId });
      const ccDocs = docs.filter((d) => d.documentType === "cc_statement");

      const mentionsAmex = q.includes("amex") || q.includes("american express");
      const baseCandidates = (() => {
        if (mentionsAmex) {
          const amex = ccDocs.filter((d) => d.filename.toLowerCase().includes("amex"));
          if (amex.length > 0) return amex;
        }
        return ccDocs;
      })();

      // If the user asked for personal spend, only consider personal-tagged statements.
      // If they asked for business spend, prefer business/unassigned statements (exclude explicitly personal).
      const candidates = (() => {
        if (wantsPersonal) {
          return baseCandidates.filter((d) => d.entityKind === "personal");
        }
        if (wantsBusiness) {
          const nonPersonal = baseCandidates.filter((d) => d.entityKind !== "personal");
          return nonPersonal.length > 0 ? nonPersonal : baseCandidates;
        }
        return baseCandidates;
      })();

      logAlwaysInDev("deterministic_spend_shortcut_candidates", {
        wantsPersonal,
        wantsBusiness,
        mentionsAmex,
        year: typeof year === "number" ? year : null,
        candidates: candidates.slice(0, 10).map((d) => ({
          id: d.id,
          filename: d.filename,
          entityKind: d.entityKind,
          entityName: d.entityName,
        })),
      });

      if (wantsPersonal && candidates.length > 1) {
        const options = candidates.slice(0, 10).map((d) => d.filename);
        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: "",
          questions_for_user: [
            `Which personal Amex statement should I use for ${typeof year === "number" ? year : "YTD"} spend? (${options.join(", ")})`,
          ],
          assumptions: [],
          tool_calls: [],
          citations: [],
          confidence: "low",
        });
      }

      if (wantsBusiness && candidates.length > 1) {
        const options = candidates.slice(0, 10).map((d) => d.filename);
        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: "",
          questions_for_user: [
            `Which business Amex statement should I use for ${typeof year === "number" ? year : "YTD"} spend? (${options.join(", ")})`,
          ],
          assumptions: [],
          tool_calls: [],
          citations: [],
          confidence: "low",
        });
      }

      // If user asked for business spend but we only have personal-tagged Amex statements,
      // compute anyway (since the DB has the transactions) and ask whether to re-tag.
      if (
        wantsBusiness &&
        mentionsAmex &&
        candidates.length === 0 &&
        baseCandidates.length === 1 &&
        typeof year === "number" &&
        Number.isFinite(year)
      ) {
        const doc = baseCandidates[0];
        const sum = await financeSum({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "cc_statement",
          filters: {
            doc_ids: [doc.id],
            date_start: `${year}-01-01`,
            date_end: `${year + 1}-01-01`,
            amount_min: 0.01,
          },
        });

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: `${year} Amex spend (from ${doc.filename}): ${sum.total} (rows: ${sum.count}).`,
          questions_for_user: [
            `That statement is currently tagged as Personal. Should I treat it as ${entityName} business and tag it accordingly?`,
          ],
          assumptions: ["Spend is computed as positive cc_statement amounts (amount > 0)."],
          tool_calls: [
            {
              toolName: "financeSum",
              input: {
                document_type: "cc_statement",
                doc_ids: [doc.id],
                year,
                amount_min: 0.01,
              },
              output: sum,
            },
          ],
          citations: [],
          confidence: sum.count === 0 ? "low" : "medium",
        });
      }

      if (candidates.length === 1 && typeof year === "number" && Number.isFinite(year)) {
        const doc = candidates[0];
        const sum = await financeSum({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "cc_statement",
          filters: {
            doc_ids: [doc.id],
            date_start: `${year}-01-01`,
            date_end: `${year + 1}-01-01`,
            amount_min: 0.01,
          },
        });

        logAlwaysInDev("deterministic_spend_shortcut_picked", {
          docId: doc.id,
          filename: doc.filename,
          year,
          count: sum.count,
          total: sum.total,
        });

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: wantsPersonal
            ? `${year} personal Amex spend (from ${doc.filename}): ${sum.total} (rows: ${sum.count}).`
            : `${year} YTD credit-card spend for ${entityName} (from ${doc.filename}): ${sum.total} (rows: ${sum.count}).`,
          questions_for_user: [],
          assumptions: ["Spend is computed as positive cc_statement amounts (amount > 0)."],
          tool_calls: [
            {
              toolName: "financeSum",
              input: {
                document_type: "cc_statement",
                doc_ids: [doc.id],
                year,
                amount_min: 0.01,
              },
              output: sum,
            },
          ],
          citations: [],
          confidence: sum.count === 0 ? "low" : "medium",
        });
      }
    }
  } catch (err) {
    // Best-effort shortcut; fall back to LLM-driven flow.
    log("deterministic_spend_shortcut_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    log("start", {
      projectId: parsed.projectId ?? null,
      hasEntityHint: Boolean(parsed.entity_hint),
      hasTimeHint: Boolean(parsed.time_hint),
      questionPreview:
        parsed.question.length > 200 ? `${parsed.question.slice(0, 200)}…` : parsed.question,
    });

  const result = await generateText({
    model,
    system,
    prompt,
    maxRetries: 1,
    tools: {
      financeQuery: financeQuery({ session, projectId: parsed.projectId }),
        projectEntitySummary: tool({
          description:
            "List the distinct entity tags (personal/business + entity name) present in the current project, with doc counts. Use this to ask the user to pick the right entity when needed.",
          inputSchema: z.object({}),
          execute: async () => {
            if (!parsed.projectId) {
              return { error: "Missing projectId" };
            }
            return await getProjectEntitySummaryForUser({
              userId: session.user.id,
              projectId: parsed.projectId,
            });
          },
        }),
    },
  });

    const summarizeOutput = (value: unknown) => {
      if (!value || typeof value !== "object") return value;
      const v = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const keys = ["query_type", "document_type", "total", "count", "rowCount", "error", "note"];
      for (const k of keys) {
        if (k in v) out[k] = v[k];
      }
      return Object.keys(out).length > 0 ? out : { type: "object" };
    };

    const toolCalls = (result as unknown as { toolCalls?: unknown }).toolCalls;
    const toolResults = (result as unknown as { toolResults?: unknown }).toolResults;
    lastToolCalls = toolCalls ?? null;
    lastToolResults = toolResults ?? null;
    log("model_result", {
      textLength: typeof result.text === "string" ? result.text.length : null,
      toolCallsCount: Array.isArray(toolCalls) ? toolCalls.length : null,
      toolResultsCount: Array.isArray(toolResults) ? toolResults.length : null,
      toolResultsSummary: Array.isArray(toolResults)
        ? toolResults.slice(0, 5).map((tr) => {
            const r = tr as { toolName?: unknown; output?: unknown };
            return {
              toolName: typeof r.toolName === "string" ? r.toolName : null,
              output: summarizeOutput(r.output),
            };
          })
        : null,
    });

    if (typeof result.text === "string" && result.text.trim().length > 0) {
    const json = JSON.parse(result.text) as unknown;
    return SpecialistAgentResponseSchema.parse(json);
    }

    // If the model returned an empty final message, fall through to deterministic fallback.
    // Don't throw (it creates scary stack traces in logs); treat as normal control flow.
    log("empty_model_text", { note: "model returned empty text; using fallback logic" });
    // Reuse the existing catch/fallback logic by forcing JSON parse failure:
    throw new Error("empty_model_text");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== "empty_model_text") {
      console.warn("FinanceAgent: invalid/empty response", error);
    }
    log("fallback_enter", {
      error: message,
      hadToolCalls: Array.isArray(lastToolCalls),
      hadToolResults: Array.isArray(lastToolResults),
    });

    // Deterministic fallback: at least ask the right clarifying question, or compute when unambiguous.
    try {
      const q = parsed.question.toLowerCase();
      const wantsPersonal = q.includes("personal") || parsed.entity_hint?.entity_kind === "personal";
      const wantsBusinessOnly = q.includes("business") && !wantsPersonal && !q.includes("combined");
      const isIncomeLike =
        q.includes("income") ||
        q.includes("revenue") ||
        q.includes("deposits") ||
        q.includes("how much did i make") ||
        q.includes("how much did we make") ||
        q.includes("bring in") ||
        q.includes("made");
      
      const isSpendLike =
        q.includes("spend") ||
        q.includes("spent") ||
        q.includes("spending") ||
        q.includes("expense") ||
        q.includes("expenses") ||
        q.includes("charge") ||
        q.includes("charges");
      const wantsCcOnly =
        q.includes("credit card") ||
        q.includes("card") ||
        q.includes("amex") ||
        q.includes("visa") ||
        q.includes("mastercard");

      if (wantsPersonal && isIncomeLike) {
        const year =
          parsed.time_hint?.kind === "year"
            ? parsed.time_hint.year ?? null
            : inferYearFromText(parsed.question) ?? new Date().getUTCFullYear();

        if (typeof year === "number" && Number.isFinite(year)) {
          const sum = await financeSum({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType: "bank_statement",
            filters: {
              entity_kind: "personal",
              amount_min: 0.01,
              exclude_categories: ["transfer", "credit card payment"],
              date_start: `${year}-01-01`,
              date_end: `${year + 1}-01-01`,
            },
          });

          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: `Personal deposit income for ${year}: ${sum.total} (rows: ${sum.count}).`,
            questions_for_user:
              sum.count === 0
                ? [
                    `I found 0 matching personal bank-statement deposits for ${year}. Are your personal statements tagged "Personal"?`,
                  ]
                : [],
            assumptions: [
              "Income is computed as bank-statement deposits (amount > 0) to Personal accounts, excluding transfers and credit-card payments.",
            ],
            tool_calls: [
              {
                toolName: "financeSum",
                input: {
                  document_type: "bank_statement",
                  entity_kind: "personal",
                  year,
                },
                output: sum,
              },
            ],
            citations: [],
            confidence: sum.count === 0 ? "low" : "medium",
          });
        }
      }

      if (wantsBusinessOnly && isIncomeLike) {
        const businessNames = await listBusinessEntityNames();
        const year =
          parsed.time_hint?.kind === "year"
            ? parsed.time_hint.year ?? null
            : inferYearFromText(parsed.question) ?? new Date().getUTCFullYear();

        const hintedName = parsed.entity_hint?.entity_name?.trim();
        const entityName =
          hintedName && hintedName.length > 0
            ? hintedName
            : businessNames.length === 1
              ? businessNames[0]
              : null;

        if (!entityName) {
          log("fallback_clarify_entity", { businessNames });
          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: "",
            questions_for_user: [
              businessNames.length > 0
                ? `Which business should I use? (${businessNames.join(", ")})`
                : "Which business should I use? (I don't see any business entities tagged yet.)",
            ],
            assumptions: [],
            tool_calls: [],
            citations: [],
            confidence: "low",
          });
        }

        if (typeof year === "number" && Number.isFinite(year)) {
          log("fallback_compute_sum", {
            entityName,
            year,
            projectId: parsed.projectId ?? null,
          });
          const sum = await financeSum({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType: "bank_statement",
            filters: {
              entity_kind: "business",
              entity_name: entityName,
              amount_min: 0.01,
              exclude_categories: ["transfer", "credit card payment"],
              date_start: `${year}-01-01`,
              date_end: `${year + 1}-01-01`,
            },
          });

          log("fallback_sum_result", {
            total: sum.total,
            count: sum.count,
          });
          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: `Business deposit income for ${entityName} in ${year}: ${sum.total} (rows: ${sum.count}).`,
            questions_for_user:
              sum.count === 0
                ? [
                    `I found 0 matching bank-statement deposits for "${entityName}" in ${year}. Are those statements tagged to a different business name, or left unassigned?`,
                  ]
                : [],
            assumptions: [
              "Income is computed as bank-statement deposits (amount > 0), excluding transfers and credit-card payments.",
            ],
            tool_calls: [
              {
                toolName: "financeSum",
                input: {
                  document_type: "bank_statement",
                  entity_kind: "business",
                  entity_name: entityName,
                  year,
                },
                output: sum,
              },
            ],
            citations: [],
            confidence: sum.count === 0 ? "low" : "medium",
          });
        }
      }

      // Spend fallback: business credit-card spend, when the model output is empty/invalid.
      if (isSpendLike && wantsCcOnly && (wantsBusinessOnly || q.includes("adventure flow"))) {
        const businessNames = await listBusinessEntityNames();
        const year =
          parsed.time_hint?.kind === "year"
            ? parsed.time_hint.year ?? null
            : inferYearFromText(parsed.question) ?? new Date().getUTCFullYear();

        const hintedName = parsed.entity_hint?.entity_name?.trim();
        const inferredName = inferBusinessNameFromText(parsed.question, businessNames);
        const entityName =
          hintedName && hintedName.length > 0
            ? hintedName
            : inferredName
              ? inferredName
              : businessNames.length === 1
                ? businessNames[0]
                : null;

        if (!entityName) {
          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: "",
            questions_for_user: [
              businessNames.length > 0
                ? `Which business should I use for spend? (${businessNames.join(", ")})`
                : "Which business should I use for spend? (I don't see any business entities tagged yet.)",
            ],
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
            questions_for_user: ["Missing projectId; please retry your question."],
            assumptions: [],
            tool_calls: [],
            citations: [],
            confidence: "low",
          });
        }

        const docs = await getProjectDocsByProjectId({ projectId: parsed.projectId });
        const matchName = entityName.trim().toLowerCase();
        const ccDocs = docs
          .filter((d) => d.documentType === "cc_statement")
          .filter((d) => d.entityKind === "business")
          .filter((d) => typeof d.entityName === "string")
          .filter((d) => (d.entityName ?? "").trim().toLowerCase() === matchName);

        // If no cc statements are tagged to the business, try a conservative filename match (e.g. "amex-ytd.csv").
        // This enables "2025 Amex spend" even when the doc is currently unassigned.
        const mentionsAmex = q.includes("amex") || q.includes("american express");
        const unassignedCcMatches = docs
          .filter((d) => d.documentType === "cc_statement")
          .filter((d) => d.entityKind !== "personal") // allow business/unassigned, but not explicitly personal
          .filter((d) => {
            const filename = d.filename.toLowerCase();
            if (mentionsAmex && !filename.includes("amex")) return false;
            // If the user said 2025, prefer "ytd" or "2025" in filename.
            if (typeof year === "number" && Number.isFinite(year)) {
              const y = String(year);
              if (filename.includes(y)) return true;
            }
            return filename.includes("ytd");
          });

        const pickedUnassigned =
          ccDocs.length === 0 && mentionsAmex && unassignedCcMatches.length === 1
            ? unassignedCcMatches[0]
            : null;

        // If the user is explicit about business spend via credit card but we only have one cc statement in the project,
        // assume it's the intended card (and ask to tag afterward).
        const allCcDocs = docs.filter((d) => d.documentType === "cc_statement");
        const pickedOnlyCc =
          ccDocs.length === 0 && !pickedUnassigned && allCcDocs.length === 1 ? allCcDocs[0] : null;

        if (pickedUnassigned && typeof year === "number" && Number.isFinite(year)) {
          const sum = await financeSum({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType: "cc_statement",
            filters: {
              doc_ids: [pickedUnassigned.id],
              date_start: `${year}-01-01`,
              date_end: `${year + 1}-01-01`,
              amount_min: 0.01,
            },
          });

          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: `2025 YTD Amex spend for ${entityName} (from ${pickedUnassigned.filename}): ${sum.total} (rows: ${sum.count}).`,
            questions_for_user:
              sum.count === 0
                ? [
                    `I found 0 matching charges for 2025 in ${pickedUnassigned.filename}. Is that file actually 2025 activity?`,
                  ]
                : [
                    `I treated ${pickedUnassigned.filename} as ${entityName}'s Amex statement. Want me to tag it to "${entityName}" so future queries auto-scope correctly?`,
                  ],
            assumptions: [
              "Spend is computed as positive cc_statement amounts (amount > 0).",
            ],
            tool_calls: [
              {
                toolName: "financeSum",
                input: {
                  document_type: "cc_statement",
                  doc_ids: [pickedUnassigned.id],
                  year,
                  amount_min: 0.01,
                },
                output: sum,
              },
            ],
            citations: [],
            confidence: sum.count === 0 ? "low" : "medium",
          });
        }

        if (pickedOnlyCc && typeof year === "number" && Number.isFinite(year)) {
          const sum = await financeSum({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType: "cc_statement",
            filters: {
              doc_ids: [pickedOnlyCc.id],
              date_start: `${year}-01-01`,
              date_end: `${year + 1}-01-01`,
              amount_min: 0.01,
            },
          });

          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: `2025 YTD credit-card spend for ${entityName} (from ${pickedOnlyCc.filename}): ${sum.total} (rows: ${sum.count}).`,
            questions_for_user: [
              `I assumed ${pickedOnlyCc.filename} is the ${entityName} business card because it's the only cc statement in this project. Want me to tag it to "${entityName}"?`,
            ],
            assumptions: [
              "Spend is computed as positive cc_statement amounts (amount > 0).",
            ],
            tool_calls: [
              {
                toolName: "financeSum",
                input: {
                  document_type: "cc_statement",
                  doc_ids: [pickedOnlyCc.id],
                  year,
                  amount_min: 0.01,
                },
                output: sum,
              },
            ],
            citations: [],
            confidence: sum.count === 0 ? "low" : "medium",
          });
        }

        if (ccDocs.length === 0) {
          const anyCc = docs
            .filter((d) => d.documentType === "cc_statement")
            .slice(0, 12)
            .map((d) => {
              const entityLabel =
                d.entityKind === "business" && typeof d.entityName === "string" && d.entityName.trim()
                  ? `Business:${d.entityName.trim()}`
                  : d.entityKind === "personal"
                    ? "Personal"
                    : "Unassigned";
              return `${d.filename} (${entityLabel})`;
            });

          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: "",
            questions_for_user: [
              anyCc.length > 0
                ? `I don't see any cc statements tagged to "${entityName}". Which credit-card statement should I use? (${anyCc.join("; ")})`
                : `I don't see any cc statements in this project yet. Please upload a ${entityName} credit-card statement.`,
            ],
            assumptions: [],
            tool_calls: [],
            citations: [],
            confidence: "low",
          });
        }

        if (ccDocs.length > 1) {
          const options = ccDocs.slice(0, 10).map((d) => d.filename);
          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: "",
            questions_for_user: [
              `Which business credit card should I use? (${options.join(", ")})`,
            ],
            assumptions: [],
            tool_calls: [],
            citations: [],
            confidence: "low",
          });
        }

        const doc = ccDocs[0];
        if (typeof year === "number" && Number.isFinite(year)) {
          const sum = await financeSum({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType: "cc_statement",
            filters: {
              doc_ids: [doc.id],
              date_start: `${year}-01-01`,
              date_end: `${year + 1}-01-01`,
              amount_min: 0.01,
            },
          });

          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: `Credit-card spend for ${entityName} in ${year} (from ${doc.filename}): ${sum.total} (rows: ${sum.count}).`,
            questions_for_user:
              sum.count === 0
                ? [
                    `I found 0 matching cc charges for ${year} in ${doc.filename}. Is that statement actually 2025 activity?`,
                  ]
                : [],
            assumptions: [
              "Spend is computed as positive cc_statement amounts (amount > 0).",
            ],
            tool_calls: [
              {
                toolName: "financeSum",
                input: {
                  document_type: "cc_statement",
                  doc_ids: [doc.id],
                  year,
                  amount_min: 0.01,
                },
                output: sum,
              },
            ],
            citations: [],
            confidence: sum.count === 0 ? "low" : "medium",
          });
        }
      }
    } catch (fallbackError) {
      console.warn("FinanceAgent fallback failed", fallbackError);
    }

    return SpecialistAgentResponseSchema.parse({
      kind: "finance",
      answer_draft: "",
      questions_for_user: [
        "I hit an internal error while running the finance query. Please retry, or rephrase with the business name and year (e.g. “Acme Inc income 2025”).",
      ],
      assumptions: [],
      tool_calls: [],
      citations: [],
      confidence: "low",
    });
  }
}
