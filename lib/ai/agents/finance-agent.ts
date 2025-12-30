import { generateText, tool } from "ai";
import type { Session } from "next-auth";
import { z } from "zod";
import { myProvider } from "@/lib/ai/providers";
import { financeQuery } from "@/lib/ai/tools/finance-query";
import {
  financeGroupByCategory,
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

  const parseIsoYmd = (ymd: string): { y: number; m: number; d: number } | null => {
    const match = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    if (y < 1900 || y > 2200) return null;
    if (m < 1 || m > 12) return null;
    if (d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d) {
      return null;
    }
    return { y, m, d };
  };

  const addDaysIso = (ymd: string, days: number): string | null => {
    const parsed = parseIsoYmd(ymd);
    if (!parsed) return null;
    const dt = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
    dt.setUTCDate(dt.getUTCDate() + days);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dt.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
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

  const inferSearchTermFromText = (text: string): string | null => {
    const trimmed = text.trim();
    if (!trimmed) return null;

    // Prefer quoted phrases: "RENEWAL MEMBERSHIP FEE"
    const quoted = trimmed.match(/"([^"]{2,200})"/);
    if (quoted && typeof quoted[1] === "string") {
      const q = quoted[1].trim();
      if (q.length > 1) return q;
    }

    // Heuristic: "was there a/an <thing> in/on/for ..."
    const lower = trimmed.toLowerCase();
    const m = lower.match(/\bwas\s+there\s+(?:an|a)\s+(.+?)\s+(?:in|on|for)\b/i);
    if (m && typeof m[1] === "string") {
      const term = trimmed.slice(m.index ?? 0).replace(/\s+/g, " ");
      // Re-run extraction on original casing by locating the captured group boundaries.
      const start = lower.indexOf(m[1], m.index ?? 0);
      if (start >= 0) {
        const raw = trimmed.slice(start, start + m[1].length).trim();
        if (raw.length > 1 && raw.length <= 200) return raw;
      }
      // Fallback to lower-cased capture
      const cap = m[1].trim();
      if (cap.length > 1 && cap.length <= 200) return cap;
    }

    // If the user typed a mostly-uppercase token group, treat it as a search term.
    const upperish = trimmed.match(/\b([A-Z0-9][A-Z0-9 &'\-]{5,120})\b/);
    if (upperish && typeof upperish[1] === "string") {
      const t = upperish[1].trim();
      if (t.length > 1) return t;
    }

    return null;
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

  const escapeMarkdownTableCell = (value: string): string =>
    value.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", " ").trim();

  const toGfmTable = (headers: readonly string[], rows: readonly (readonly string[])[]): string => {
    const headerLine = `| ${headers.map(escapeMarkdownTableCell).join(" | ")} |`;
    const sepLine = `| ${headers.map(() => "---").join(" | ")} |`;
    const rowLines = rows.map((r) => `| ${r.map((c) => escapeMarkdownTableCell(c)).join(" | ")} |`);
    return [headerLine, sepLine, ...rowLines].join("\n");
  };

  const clipText = (value: string, maxLen: number): string => {
    if (value.length <= maxLen) return value;
    return `${value.slice(0, Math.max(0, maxLen - 1))}…`;
  };

  const system = `You are FinanceAgent.

You MUST return ONLY valid JSON that matches this schema:
${SpecialistAgentResponseSchema.toString()}

Rules:
- Use financeQuery for any totals/sums/aggregations. Never compute math yourself.
- If you request a breakdown (e.g. group_by_month), also call query_type='sum' for the same range so you can provide an exact total in answer_draft.
- Prefer bank_statement deposits for income-like questions (made/brought in/income/deposits/revenue), with filters.amount_min > 0.
- CRITICAL: For "income" or "revenue" questions, you MUST set filters.exclude_categories=['transfer', 'credit card payment'] unless the user asks for transfers.
- When explaining exclusions, refer to 'credit card payment' as 'payments to credit card accounts' to avoid confusion with credit card sales.
- When presenting structured results (breakdowns, lists, comparisons), prefer GitHub-flavored markdown tables in answer_draft.
- For "spend"/"spent"/"expenses"/"charges" questions:
  - You MUST run financeQuery (do not say you can't retrieve data unless financeQuery returns an error).
  - If the user asks for a breakdown "by category", use query_type='group_by_category' (categories may be NULL; include an "Uncategorized" bucket).
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
    const wantsCategoryBreakdown = q.includes("by category") || q.includes("categories");
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

    const inferMonthWindowUtc = (
      textLower: string
    ):
      | {
          year: number;
          month: number; // 1-12
          date_start: string; // YYYY-MM-01
          date_end: string; // first day of next month (YYYY-MM-01)
          label: string; // YYYY-MM
        }
      | null => {
      const hinted =
        parsed.time_hint?.kind === "month" &&
        typeof parsed.time_hint.year === "number" &&
        typeof parsed.time_hint.month === "number"
          ? { year: parsed.time_hint.year, month: parsed.time_hint.month }
          : null;

      const month =
        hinted?.month ??
        monthFromText ??
        (textLower.includes("this month") || textLower.includes("month to date") || textLower.includes("mtd")
          ? new Date().getUTCMonth() + 1
          : null);
      if (typeof month !== "number" || !Number.isFinite(month) || month < 1 || month > 12) return null;

      const year =
        hinted?.year ??
        (parsed.time_hint?.kind === "year" ? (parsed.time_hint.year ?? null) : null) ??
        inferYearFromText(parsed.question) ??
        new Date().getUTCFullYear();
      if (typeof year !== "number" || !Number.isFinite(year) || year < 1900 || year > 2200) return null;

      const mm = String(month).padStart(2, "0");
      const date_start = `${year}-${mm}-01`;
      const endYear = month === 12 ? year + 1 : year;
      const endMonth = month === 12 ? 1 : month + 1;
      const endMm = String(endMonth).padStart(2, "0");
      const date_end = `${endYear}-${endMm}-01`;
      return { year, month, date_start, date_end, label: `${year}-${mm}` };
    };

    const inferDateRangeUtc = (
      textLower: string
    ):
      | { kind: "month"; date_start: string; date_end: string; label: string }
      | { kind: "range"; date_start: string; date_end: string; label: string }
      | { kind: "half"; date_start: string; date_end: string; label: string }
      | null => {
      // Explicit ISO date range: "from 2025-01-01 to 2025-12-30"
      // date_end is exclusive, so we add 1 day to the end date.
      const isoDates = Array.from(textLower.matchAll(/\b(19\d{2}|20\d{2})-\d{2}-\d{2}\b/g)).map(
        (m) => m[0]
      );
      if (isoDates.length >= 2) {
        const start = isoDates[0];
        const endInclusive = isoDates[1];
        const startOk = parseIsoYmd(start);
        const endOk = parseIsoYmd(endInclusive);
        const endExclusive = addDaysIso(endInclusive, 1);
        if (startOk && endOk && typeof endExclusive === "string") {
          return {
            kind: "range",
            date_start: start,
            date_end: endExclusive,
            label: `${start}..${endInclusive}`,
          };
        }
      }

      // Multi-month range (e.g. "September, October, and November 2025")
      const mentionedMonths = (() => {
        const byName: Array<[string, number]> = [
          ["january", 1],
          ["jan", 1],
          ["february", 2],
          ["feb", 2],
          ["march", 3],
          ["mar", 3],
          ["april", 4],
          ["apr", 4],
          ["may", 5],
          ["june", 6],
          ["jun", 6],
          ["july", 7],
          ["jul", 7],
          ["august", 8],
          ["aug", 8],
          ["september", 9],
          ["sept", 9],
          ["sep", 9],
          ["october", 10],
          ["oct", 10],
          ["november", 11],
          ["nov", 11],
          ["december", 12],
          ["dec", 12],
        ];
        const out: number[] = [];
        for (const [k, v] of byName) {
          if (!textLower.includes(k)) continue;
          if (!out.includes(v)) out.push(v);
        }
        return out.sort((a, b) => a - b);
      })();

      const yearDefault = new Date().getUTCFullYear();
      const year =
        (parsed.time_hint?.kind === "year" ? (parsed.time_hint.year ?? null) : null) ??
        inferYearFromText(parsed.question) ??
        yearDefault;

      if (mentionedMonths.length >= 2 && typeof year === "number" && Number.isFinite(year)) {
        const startMonth = mentionedMonths[0];
        const endMonth = mentionedMonths[mentionedMonths.length - 1];
        const startMm = String(startMonth).padStart(2, "0");
        const date_start = `${year}-${startMm}-01`;
        const endYear = endMonth === 12 ? year + 1 : year;
        const endMm = String(endMonth === 12 ? 1 : endMonth + 1).padStart(2, "0");
        const date_end = `${endYear}-${endMm}-01`;
        return {
          kind: "range",
          date_start,
          date_end,
          label: `${year}-${String(startMonth).padStart(2, "0")}..${year}-${String(endMonth).padStart(2, "0")}`,
        };
      }

      // Single month (including "this month")
      const month = inferMonthWindowUtc(textLower);
      if (month) {
        return { kind: "month", date_start: month.date_start, date_end: month.date_end, label: month.label };
      }

      // Half-year / last 6 months of a year
      const mentionsHalf =
        textLower.includes("half") ||
        textLower.includes("h1") ||
        textLower.includes("h2") ||
        textLower.includes("first half") ||
        textLower.includes("second half") ||
        textLower.includes("last 6 months of the year") ||
        textLower.includes("last six months of the year");
      if (!mentionsHalf) return null;

      if (!(typeof year === "number" && Number.isFinite(year) && year >= 1900 && year <= 2200)) return null;

      const isH1 =
        textLower.includes("h1") ||
        textLower.includes("first half") ||
        textLower.includes("1st half") ||
        textLower.includes("first-half");
      const isH2 =
        textLower.includes("h2") ||
        textLower.includes("second half") ||
        textLower.includes("2nd half") ||
        textLower.includes("second-half") ||
        textLower.includes("last half") ||
        textLower.includes("last 6 months of the year") ||
        textLower.includes("last six months of the year");

      const half: 1 | 2 = isH2 ? 2 : isH1 ? 1 : 2;
      if (half === 1) {
        return {
          kind: "half",
          date_start: `${year}-01-01`,
          date_end: `${year}-07-01`,
          label: `H1 ${year} (Jan–Jun)`,
        };
      }
      return {
        kind: "half",
        date_start: `${year}-07-01`,
        date_end: `${year + 1}-01-01`,
        label: `H2 ${year} (Jul–Dec)`,
      };
    };

    // Personal income for a specific range (month, half-year, or custom): sum bank_statement deposits.
    const personalIncomeRange = inferDateRangeUtc(q);
    if (parsed.projectId && wantsPersonal && isIncomeLike && personalIncomeRange && !q.includes("last") && !q.includes("past")) {
      const { date_start, date_end, label } = personalIncomeRange;
      const sum = await financeSum({
        userId: session.user.id,
        projectId: parsed.projectId,
        documentType: "bank_statement",
        filters: {
          entity_kind: "personal",
          amount_min: 0.01,
          exclude_categories: ["transfer", "credit card payment"],
          date_start,
          date_end,
        },
      });

      let breakdownTable = "";
      let grouped = null;
      if (personalIncomeRange.kind !== "month") {
        grouped = await financeGroupByMonth({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "bank_statement",
          filters: {
            entity_kind: "personal",
            amount_min: 0.01,
            exclude_categories: ["transfer", "credit card payment"],
            date_start,
            date_end,
          },
        });

        const wantMonths = enumerateMonths(date_start, date_end);
        const totalsByMonth = new Map<string, { total: string; count: number }>();
        if (Array.isArray(grouped.rows)) {
          for (const r of grouped.rows) {
            if (!r || typeof r !== "object") continue;
            const row = r as { month?: string; total?: string; count?: number };
            if (typeof row.month === "string" && typeof row.total === "string") {
              totalsByMonth.set(row.month, { total: row.total, count: row.count ?? 0 });
            }
          }
        }

        const tableRows = wantMonths.map((m) => {
          const entry = totalsByMonth.get(m);
          return [m, `$${entry?.total ?? "0"}`, `${entry?.count ?? 0}`];
        });
        breakdownTable = `\n\nMonth-by-month breakdown:\n${toGfmTable(["Month", "Deposits", "#"], tableRows)}`;
      }

      return SpecialistAgentResponseSchema.parse({
        kind: "finance",
        answer_draft: `Personal deposit income in ${label}: $${sum.total} (${sum.count} rows).${breakdownTable}`,
        questions_for_user:
          sum.count === 0
            ? [
                `I found 0 matching personal bank-statement deposits in ${label}. Are your personal bank statements tagged Personal?`,
              ]
            : [],
        assumptions: [
          "Income is computed as bank-statement deposits (amount > 0) to Personal accounts, excluding transfers and payments made to credit card accounts.",
        ],
        tool_calls: [
          {
            toolName: "financeSum",
            input: {
              document_type: "bank_statement",
              entity_kind: "personal",
              date_start,
              date_end,
              amount_min: 0.01,
              exclude_categories: ["transfer", "credit card payment"],
            },
            output: sum,
          },
          ...(grouped
            ? [
                {
                  toolName: "financeGroupByMonth",
                  input: {
                    document_type: "bank_statement",
                    entity_kind: "personal",
                    date_start,
                    date_end,
                    amount_min: 0.01,
                    exclude_categories: ["transfer", "credit card payment"],
                  },
                  output: grouped,
                },
              ]
            : []),
        ],
        citations: [],
        confidence: sum.count === 0 ? "low" : "medium",
      });
    }

    // Personal credit-card spend by category for an inferred range (e.g. "last half of 2025 by category").
    if (parsed.projectId && wantsPersonal && wantsCc && isSpendLike && wantsCategoryBreakdown) {
      const range = inferDateRangeUtc(q);
      if (range?.kind === "half") {
        const sumPos = await financeSum({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "cc_statement",
          filters: {
            entity_kind: "personal",
            date_start: range.date_start,
            date_end: range.date_end,
            amount_min: 0.01,
          },
        });

        const useNeg = sumPos.count === 0;
        const sum = useNeg
          ? await financeSum({
              userId: session.user.id,
              projectId: parsed.projectId,
              documentType: "cc_statement",
              filters: {
                entity_kind: "personal",
                date_start: range.date_start,
                date_end: range.date_end,
                amount_max: -0.01,
              },
            })
          : sumPos;

        const grouped = await financeGroupByCategory({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "cc_statement",
          filters: {
            entity_kind: "personal",
            date_start: range.date_start,
            date_end: range.date_end,
            ...(useNeg ? { amount_max: -0.01 } : { amount_min: 0.01 }),
          },
        });

        const absDecimalString = (s: string): string => (s.startsWith("-") ? s.slice(1) : s);
        const rows = Array.isArray(grouped.rows) ? grouped.rows : [];
        const tableRows = rows.slice(0, 15).map((r) => {
          const cat =
            typeof r.category === "string" && r.category.trim().length > 0
              ? r.category.trim()
              : "Uncategorized";
          const amt = typeof r.total === "string" ? absDecimalString(r.total) : String(r.total);
          return [cat, `$${amt}`, `${r.count}`];
        });
        const byCategoryTable =
          tableRows.length > 0 ? toGfmTable(["Category", "Total", "Txns"], tableRows) : "";

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: [
            `Personal credit-card spend by category for ${range.label}:`,
            `- Total: $${typeof sum.total === "string" ? absDecimalString(sum.total) : String(sum.total)}${
              useNeg ? " (note: amounts were stored as negatives; totals shown as absolute)" : ""
            }`,
            `- Transactions: ${sum.count}`,
            "",
            "By category:",
            byCategoryTable,
            rows.length > 15 ? "\n(Showing top 15 categories.)" : "",
          ].join("\n"),
          questions_for_user: [],
          assumptions: [
            "Spend is computed from cc_statement transactions for the specified window.",
            "Categories come from the parsed transaction category field; missing categories are grouped as Uncategorized.",
          ],
          tool_calls: [
            {
              toolName: "financeSum",
              input: {
                document_type: "cc_statement",
                entity_kind: "personal",
                date_start: range.date_start,
                date_end: range.date_end,
                ...(useNeg ? { amount_max: -0.01 } : { amount_min: 0.01 }),
              },
              output: sum,
            },
            {
              toolName: "financeGroupByCategory",
              input: {
                document_type: "cc_statement",
                entity_kind: "personal",
                date_start: range.date_start,
                date_end: range.date_end,
                ...(useNeg ? { amount_max: -0.01 } : { amount_min: 0.01 }),
              },
              output: grouped,
            },
          ],
          citations: [],
          confidence: sum.count === 0 ? "low" : "medium",
        });
      }
    }

    // List charges for a specific month with date/description/amount (avoid one-off statement picking).
    if (parsed.projectId && isSpendLike && monthFromText && (q.includes("list") || q.includes("show"))) {
      const range = inferDateRangeUtc(q);
      if (range?.kind === "month") {
        // If entity isn't explicit, ask rather than guessing.
        if (!wantsPersonal && !wantsBusiness) {
          const businessNames = await listBusinessEntityNames();
          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: "",
            questions_for_user: [
              businessNames.length > 0
                ? `Is this Personal, or which business? (${["Personal", ...businessNames].join(", ")})`
                : "Is this Personal or Business?",
            ],
            assumptions: [],
            tool_calls: [],
            citations: [],
            confidence: "low",
          });
        }

        const businessNames = wantsBusiness ? await listBusinessEntityNames() : [];
        const hintedName = parsed.entity_hint?.entity_name?.trim();
        const inferredName = wantsBusiness ? inferBusinessNameFromText(parsed.question, businessNames) : null;
        const entityName =
          wantsBusiness
            ? hintedName && hintedName.length > 0
              ? hintedName
              : inferredName
                ? inferredName
                : businessNames.length === 1
                  ? businessNames[0]
                  : null
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

        const listPos = await financeList({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "cc_statement",
          filters: {
            ...(wantsPersonal ? { entity_kind: "personal" } : { entity_kind: "business", entity_name: entityName ?? "" }),
            date_start: range.date_start,
            date_end: range.date_end,
            amount_min: 0.01,
          },
        });
        const rowsPosAny: unknown[] = listPos.query_type === "list" ? (listPos.rows as unknown[]) : [];
        const listNeg =
          rowsPosAny.length === 0
            ? await financeList({
                userId: session.user.id,
                projectId: parsed.projectId,
                documentType: "cc_statement",
                filters: {
                  ...(wantsPersonal ? { entity_kind: "personal" } : { entity_kind: "business", entity_name: entityName ?? "" }),
                  date_start: range.date_start,
                  date_end: range.date_end,
                  amount_max: -0.01,
                },
              })
            : null;
        const rowsNegAny: unknown[] =
          listNeg && listNeg.query_type === "list" ? (listNeg.rows as unknown[]) : [];
        const usedRowsAny = rowsNegAny.length > 0 ? rowsNegAny : rowsPosAny;
        const negAmounts = rowsNegAny.length > 0;

        const absDecimalString = (s: string): string => (s.startsWith("-") ? s.slice(1) : s);
        const isTxnRow = (row: unknown): row is { txnDate: string; description: string | null; amount: string } => {
          if (!row || typeof row !== "object") return false;
          const r = row as Record<string, unknown>;
          return (
            typeof r.txnDate === "string" &&
            typeof r.amount === "string" &&
            (typeof r.description === "string" || r.description === null)
          );
        };
        const txnRows = usedRowsAny.filter(isTxnRow);
        const tableRows = txnRows.slice(0, 200).map((r) => {
          const desc = typeof r.description === "string" ? r.description.trim() : "";
          const amt = negAmounts ? absDecimalString(r.amount) : r.amount;
          return [r.txnDate, clipText(desc || "(no description)", 120), `$${amt}`];
        });
        const chargesTable =
          tableRows.length > 0 ? toGfmTable(["Date", "Description", "Amount"], tableRows) : "";

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: [
            `Charges in ${range.label}${negAmounts ? " (note: amounts were stored as negatives; shown as absolute)" : ""}:`,
            `Transactions: ${txnRows.length}`,
            "",
            chargesTable,
            txnRows.length > 200 ? "\n(Showing first 200 transactions.)" : "",
          ]
            .filter((s) => s.length > 0)
            .join("\n"),
          questions_for_user: txnRows.length === 0 ? ["I found 0 matching charges for that month. Is the year correct?"] : [],
          assumptions: ["For credit cards, charges may be stored as positive or negative amounts depending on export; this tries both conventions."],
          tool_calls: [
            {
              toolName: "financeList",
              input: {
                document_type: "cc_statement",
                ...(wantsPersonal ? { entity_kind: "personal" } : { entity_kind: "business", entity_name: entityName }),
                date_start: range.date_start,
                date_end: range.date_end,
                amount_min: 0.01,
              },
              output: listPos,
            },
            ...(listNeg
              ? [
                  {
                    toolName: "financeList",
                    input: {
                      document_type: "cc_statement",
                      ...(wantsPersonal ? { entity_kind: "personal" } : { entity_kind: "business", entity_name: entityName }),
                      date_start: range.date_start,
                      date_end: range.date_end,
                      amount_max: -0.01,
                    },
                    output: listNeg,
                  },
                ]
              : []),
          ],
          citations: [],
          confidence: txnRows.length === 0 ? "low" : "medium",
        });
      }
    }

    // Business spend: find transactions matching a description term (e.g. "was there a RENEWAL MEMBERSHIP FEE in 2025?").
    if (parsed.projectId && wantsBusiness && isSpendLike) {
      const term = inferSearchTermFromText(parsed.question);
      const year =
        parsed.time_hint?.kind === "year"
          ? parsed.time_hint.year ?? null
          : inferYearFromText(parsed.question) ?? new Date().getUTCFullYear();

      if (term && typeof year === "number" && Number.isFinite(year)) {
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
                ? `Which business should I search? (${businessNames.join(", ")})`
                : "Which business should I search?",
            ],
            assumptions: [],
            tool_calls: [],
            citations: [],
            confidence: "low",
          });
        }

        const date_start = `${year}-01-01`;
        const date_end = `${year + 1}-01-01`;

        const ccPos = await financeList({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "cc_statement",
          filters: {
            entity_kind: "business",
            entity_name: entityName,
            vendor_contains: term,
            date_start,
            date_end,
            amount_min: 0.01,
          },
        });
        const ccPosRows = ccPos.query_type === "list" ? ccPos.rows : [];

        const ccNeg =
          ccPosRows.length === 0
            ? await financeList({
                userId: session.user.id,
                projectId: parsed.projectId,
                documentType: "cc_statement",
                filters: {
                  entity_kind: "business",
                  entity_name: entityName,
                  vendor_contains: term,
                  date_start,
                  date_end,
                  amount_max: -0.01,
                },
              })
            : null;
        const ccNegRows = ccNeg && ccNeg.query_type === "list" ? ccNeg.rows : [];

        const bankPos =
          ccPosRows.length === 0 && ccNegRows.length === 0
            ? await financeList({
                userId: session.user.id,
                projectId: parsed.projectId,
                documentType: "bank_statement",
                filters: {
                  entity_kind: "business",
                  entity_name: entityName,
                  vendor_contains: term,
                  date_start,
                  date_end,
                },
              })
            : null;
        const bankRows = bankPos && bankPos.query_type === "list" ? bankPos.rows : [];

        const absDecimalString = (s: string): string => (s.startsWith("-") ? s.slice(1) : s);
        const isTxnRow = (row: unknown): row is { txnDate: string; description: string | null; amount: string } => {
          if (!row || typeof row !== "object") return false;
          const r = row as Record<string, unknown>;
          return (
            typeof r.txnDate === "string" &&
            typeof r.amount === "string" &&
            (typeof r.description === "string" || r.description === null)
          );
        };

        const summarizeRows = (rows: unknown[], negAmounts: boolean): string => {
          const out: Array<[string, string, string]> = [];
          for (const row of rows) {
            if (!isTxnRow(row)) continue;
            const desc = typeof row.description === "string" ? row.description.trim() : "";
            const amount = negAmounts ? absDecimalString(row.amount) : row.amount;
            out.push([row.txnDate, clipText(desc || "(no description)", 120), `$${amount}`]);
            if (out.length >= 20) break;
          }
          return out.length > 0 ? toGfmTable(["Date", "Description", "Amount"], out) : "";
        };

        const sourceLabel =
          ccPosRows.length > 0
            ? "business credit card (positive amounts)"
            : ccNegRows.length > 0
              ? "business credit card (negative amounts; shown as absolute)"
              : bankRows.length > 0
                ? "business bank statement"
                : null;

        const matchesTable =
          ccPosRows.length > 0
            ? summarizeRows(ccPosRows, false)
            : ccNegRows.length > 0
              ? summarizeRows(ccNegRows, true)
              : bankRows.length > 0
                ? summarizeRows(bankRows, false)
                : "";
        const found = matchesTable.length > 0;

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: found
            ? [
                `Yes — I found matching transactions for "${term}" in ${entityName} (${year}).`,
                sourceLabel ? `Source: ${sourceLabel}` : "",
                "",
                "Matches:",
                matchesTable,
                "\n(Showing first 20 matches.)",
              ]
                .filter((s) => s.length > 0)
                .join("\n")
            : `No — I didn’t find any ${entityName} transactions in ${year} whose description matches "${term}".`,
          questions_for_user: [],
          assumptions: [
            "Matching is done by searching the transaction description field.",
            "For credit-card statements, charges may be stored as positive or negative amounts depending on export; this check tries both conventions.",
          ],
          tool_calls: [
            {
              toolName: "financeList",
              input: {
                document_type: "cc_statement",
                entity_kind: "business",
                entity_name: entityName,
                vendor_contains: term,
                date_start,
                date_end,
                amount_min: 0.01,
              },
              output: ccPos,
            },
            ...(ccNeg
              ? [
                  {
                    toolName: "financeList",
                    input: {
                      document_type: "cc_statement",
                      entity_kind: "business",
                      entity_name: entityName,
                      vendor_contains: term,
                      date_start,
                      date_end,
                      amount_max: -0.01,
                    },
                    output: ccNeg,
                  },
                ]
              : []),
            ...(bankPos
              ? [
                  {
                    toolName: "financeList",
                    input: {
                      document_type: "bank_statement",
                      entity_kind: "business",
                      entity_name: entityName,
                      vendor_contains: term,
                      date_start,
                      date_end,
                    },
                    output: bankPos,
                  },
                ]
              : []),
          ],
          citations: [],
          confidence: found ? "medium" : "low",
        });
      }
    }

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
      const tableRows = shown.map((r) => {
        const desc = typeof r.description === "string" ? r.description.trim() : "";
        return [r.txnDate, clipText(desc || "(no description)", 140), `$${r.amount}`];
      });
      const breakdownTable =
        tableRows.length > 0 ? toGfmTable(["Date", "Description", "Amount"], tableRows) : "";

      return SpecialistAgentResponseSchema.parse({
        kind: "finance",
        answer_draft:
          sum.count === 0
            ? `Personal deposits in the last ${rollingDays} days (${date_start} to ${date_end}): ${sum.total} (rows: ${sum.count}).`
            : [
                `Personal deposits in the last ${rollingDays} days (${date_start} to ${date_end}): $${sum.total}`,
                `Number of deposits: ${sum.count}`,
                "",
                "By transaction:",
                breakdownTable,
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
          "Income is computed as bank-statement deposits (amount > 0) to Personal accounts, excluding transfers and payments made to credit card accounts.",
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
      const tableRows = shown.map((r) => {
        const desc = typeof r.description === "string" ? r.description.trim() : "";
        return [r.txnDate, clipText(desc || "(no description)", 140), `$${r.amount}`];
      });
      const breakdownTable =
        tableRows.length > 0 ? toGfmTable(["Date", "Description", "Amount"], tableRows) : "";

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
                "By transaction:",
                breakdownTable,
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
          "Income is computed as bank-statement deposits (amount > 0) to Personal accounts, excluding transfers and payments made to credit card accounts.",
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

    // Business income for a specific range (month, half-year, or custom): sum bank_statement deposits.
    const bizIncomeRange = inferDateRangeUtc(q);
    if (isIncomeLike && wantsBusiness && bizIncomeRange && parsed.projectId && !q.includes("last") && !q.includes("past")) {
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
              : "Which business should I use? (I don't see any business entities tagged yet.)",
          ],
          assumptions: [],
          tool_calls: [],
          citations: [],
          confidence: "low",
        });
      }

      const { date_start, date_end, label } = bizIncomeRange;

      const sum = await financeSum({
        userId: session.user.id,
        projectId: parsed.projectId,
        documentType: "bank_statement",
        filters: {
          entity_kind: "business",
          entity_name: entityName,
          amount_min: 0.01,
          exclude_categories: ["transfer", "credit card payment"],
          date_start,
          date_end,
        },
      });

      let breakdownTable = "";
      let grouped = null;
      if (bizIncomeRange.kind !== "month") {
        grouped = await financeGroupByMonth({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "bank_statement",
          filters: {
            entity_kind: "business",
            entity_name: entityName,
            amount_min: 0.01,
            exclude_categories: ["transfer", "credit card payment"],
            date_start,
            date_end,
          },
        });

        const wantMonths = enumerateMonths(date_start, date_end);
        const totalsByMonth = new Map<string, { total: string; count: number }>();
        if (Array.isArray(grouped.rows)) {
          for (const r of grouped.rows) {
            if (!r || typeof r !== "object") continue;
            const row = r as { month?: string; total?: string; count?: number };
            if (typeof row.month === "string" && typeof row.total === "string") {
              totalsByMonth.set(row.month, { total: row.total, count: row.count ?? 0 });
            }
          }
        }

        const tableRows = wantMonths.map((m) => {
          const entry = totalsByMonth.get(m);
          return [m, `$${entry?.total ?? "0"}`, `${entry?.count ?? 0}`];
        });
        breakdownTable = `\n\nMonth-by-month breakdown:\n${toGfmTable(["Month", "Deposits", "#"], tableRows)}`;
      }

      return SpecialistAgentResponseSchema.parse({
        kind: "finance",
        answer_draft: `Total business income deposits for ${entityName} in ${label}: $${sum.total} (${sum.count} rows).${breakdownTable}`,
        questions_for_user:
          sum.count === 0
            ? [`I found 0 business deposits for ${entityName} in ${label}. Is your business bank statement tagged to "${entityName}"?`]
            : [],
        assumptions: [
          "Income is computed as bank-statement deposits (amount > 0), excluding transfers and payments made to credit card accounts.",
        ],
        tool_calls: [
          {
            toolName: "financeSum",
            input: {
              document_type: "bank_statement",
              entity_kind: "business",
              entity_name: entityName,
              date_start,
              date_end,
              amount_min: 0.01,
              exclude_categories: ["transfer", "credit card payment"],
            },
            output: sum,
          },
          ...(grouped
            ? [
                {
                  toolName: "financeGroupByMonth",
                  input: {
                    document_type: "bank_statement",
                    entity_kind: "business",
                    entity_name: entityName,
                    date_start,
                    date_end,
                    amount_min: 0.01,
                    exclude_categories: ["transfer", "credit card payment"],
                  },
                  output: grouped,
                },
              ]
            : []),
        ],
        citations: [],
        confidence: sum.count === 0 ? "low" : "medium",
      });
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
        const tableRows = topRows.map((r) => {
          const merchant = typeof r.merchant === "string" && r.merchant.trim().length > 0 ? r.merchant.trim() : "(unknown)";
          return [clipText(merchant, 80), `$${String(r.total)}`, `${r.count}`];
        });
        const topTable =
          tableRows.length > 0 ? toGfmTable(["Description", "Total", "Txns"], tableRows) : "";

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: [
            `Personal Amex spend summary for ${year} (charges only):`,
            `- Total: ${total.total}`,
            `- Transactions: ${total.count}`,
            "",
            "Top descriptions by spend:",
            topTable,
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

        const tableRows = wantMonths.map((m) => [m, `$${totalsByMonth.get(m) ?? "0"}`]);
        const byMonthTable = toGfmTable(["Month", "Total"], tableRows);

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: [
            `Monthly spend on your personal Amex for the last ${safeMonths} full calendar months (${date_start} to ${date_end}):`,
            "",
            byMonthTable,
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

    // Credit-card spend for a specific month or a multi-month span (e.g. "October 2025", or "September, October, and November 2025").
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
        const inferredRange = inferDateRangeUtc(q);
        const mm = String(monthFromText).padStart(2, "0");
        const date_start =
          inferredRange?.kind === "range" ? inferredRange.date_start : `${year}-${mm}-01`;
        const date_end =
          inferredRange?.kind === "range"
            ? inferredRange.date_end
            : (() => {
                const endYear = monthFromText === 12 ? year + 1 : year;
                const endMonth = monthFromText === 12 ? 1 : monthFromText + 1;
                const endMm = String(endMonth).padStart(2, "0");
                return `${endYear}-${endMm}-01`;
              })();
        const label =
          inferredRange?.kind === "range" ? inferredRange.label : `${year}-${mm}`;

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

        const docIds = candidates.map((d) => d.id);
        const absDecimalString = (s: string): string => (s.startsWith("-") ? s.slice(1) : s);

        // Prefer positive-charge convention. If 0 rows, fall back to negative-charge convention and present absolute.
        const sumPos = (await financeSum({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "cc_statement",
          filters: {
            doc_ids: docIds,
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
                  doc_ids: docIds,
                  date_start,
                  date_end,
                  amount_max: -0.01,
                },
              })) as { total: string; count: number })
            : null;

        const usedIsNeg = Boolean(sumNeg && sumNeg.count > 0);
        const used = usedIsNeg ? (sumNeg as { total: string; count: number }) : sumPos;
        const total = typeof used.total === "string" ? absDecimalString(used.total) : String(used.total);
        const signNote =
          usedIsNeg
            ? " (note: amounts were stored as negatives; total shown as absolute)"
            : "";

        const breakdownLines = await (async () => {
          try {
            if (wantsCategoryBreakdown) {
              const grouped = await financeGroupByCategory({
                userId: session.user.id,
                projectId: parsed.projectId,
                documentType: "cc_statement",
                filters: {
                  doc_ids: docIds,
                  date_start,
                  date_end,
                  ...(usedIsNeg ? { amount_max: -0.01 } : { amount_min: 0.01 }),
                },
              });
              const rows = Array.isArray(grouped.rows) ? grouped.rows : [];
              if (rows.length === 0) return "";
              const tableRows = rows.slice(0, 12).map((r) => {
                const category =
                  typeof r.category === "string" && r.category.trim().length > 0
                    ? r.category.trim()
                    : "Uncategorized";
                const amt = typeof r.total === "string" ? absDecimalString(r.total) : String(r.total);
                return [category, `$${amt}`, `${r.count}`];
              });
              const table = toGfmTable(["Category", "Total", "Txns"], tableRows);
              return `\n\nSpending by category:\n${table}${rows.length > 12 ? "\n\n(Showing top 12 categories.)" : ""}`;
            }

            const top = await financeGroupByMerchant({
              userId: session.user.id,
              projectId: parsed.projectId,
              documentType: "cc_statement",
              filters: {
                doc_ids: docIds,
                date_start,
                date_end,
                ...(usedIsNeg ? { amount_max: -0.01 } : { amount_min: 0.01 }),
              },
            });
            const rows = Array.isArray(top.rows) ? top.rows : [];
            if (rows.length === 0) return "";
            const tableRows = rows.slice(0, 8).map((r) => {
              const description =
                typeof r.merchant === "string" && r.merchant.trim().length > 0
                  ? r.merchant.trim()
                  : "(no description)";
              const amt = typeof r.total === "string" ? absDecimalString(r.total) : String(r.total);
              return [clipText(description, 80), `$${amt}`];
            });
            const table = toGfmTable(["Description", "Total"], tableRows);
            return `\n\nTop spending by description:\n${table}${rows.length > 8 ? "\n\n(Showing top 8 descriptions.)" : ""}`;
          } catch (err) {
            console.warn("FinanceAgent: breakdown shortcut failed", err);
            return "";
          }
        })();

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: wantsBusiness && entityName
            ? `You spent $${total} on ${entityName}${mentionsAmex ? " Amex" : ""} in ${label}${signNote}.${breakdownLines}`
            : `You spent $${total} on your personal credit card${mentionsAmex ? " (Amex)" : ""} in ${label}${signNote}.${breakdownLines}`,
          questions_for_user: [],
          assumptions: ["Spend is computed from cc_statement transactions for the specified month; transfers/payments are not included unless present as transactions."],
          tool_calls: [
            {
              toolName: "financeSum",
              input: {
                document_type: "cc_statement",
                doc_ids: docIds,
                date_start,
                date_end,
                ...(usedIsNeg ? { amount_max: -0.01 } : { amount_min: 0.01 }),
              },
              output: used,
            },
            {
              toolName: wantsCategoryBreakdown ? "financeGroupByCategory" : "financeGroupByMerchant",
              input: {
                document_type: "cc_statement",
                doc_ids: docIds,
                date_start,
                date_end,
                ...(usedIsNeg ? { amount_max: -0.01 } : { amount_min: 0.01 }),
              },
              output: { note: "See answer text for summary" },
            },
          ],
          citations: [],
          confidence: used.count === 0 ? "low" : "medium",
        });
      }
    }

    // Explicit-range spend breakdown by merchant (e.g. "from 2025-01-01 to 2025-12-30 ... by merchant")
    if (parsed.projectId && wantsPersonal && isSpendLike && q.includes("merchant")) {
      const range = inferDateRangeUtc(q);
      if (range?.kind === "range" || range?.kind === "half") {
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
              "I don’t see any personal credit-card statements tagged Personal yet. Which statement(s) should I use for this spend query?",
            ],
            assumptions: [],
            tool_calls: [],
            citations: [],
            confidence: "low",
          });
        }

        const wantsGroceries = q.includes("grocery") || q.includes("groceries");
        const filters = {
          doc_ids: docIds,
          date_start: range.date_start,
          date_end: range.date_end,
          amount_min: 0.01,
          ...(wantsGroceries ? { categories_in: ["groceries"] } : {}),
        };

        const total = await financeSum({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "cc_statement",
          filters,
        });
        const grouped = await financeGroupByMerchant({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "cc_statement",
          filters,
        });

        const rows = Array.isArray(grouped.rows) ? grouped.rows : [];
        const topRows = rows.slice(0, 30);
        const tableRows = topRows.map((r) => {
          const merchant =
            typeof r.merchant === "string" && r.merchant.trim().length > 0
              ? r.merchant.trim()
              : "(unknown)";
          return [clipText(merchant, 80), `$${String(r.total)}`, `${r.count}`];
        });
        const topTable =
          tableRows.length > 0 ? toGfmTable(["Merchant", "Total", "Txns"], tableRows) : "";

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: [
            `Personal card spend${wantsGroceries ? " on groceries" : ""} in ${range.label} (charges only):`,
            `- Total: $${total.total}`,
            `- Transactions: ${total.count}`,
            "",
            "Top merchants by spend:",
            topTable,
          ].join("\n"),
          questions_for_user: [],
          assumptions: [
            "Spend is computed as positive cc_statement amounts (amount > 0).",
            ...(wantsGroceries
              ? ['Filtered to transactions categorized as "groceries".']
              : []),
          ],
          tool_calls: [
            {
              toolName: "financeSum",
              input: {
                document_type: "cc_statement",
                doc_ids: docIds,
                date_start: range.date_start,
                date_end: range.date_end,
                amount_min: 0.01,
                ...(wantsGroceries ? { categories_in: ["groceries"] } : {}),
              },
              output: total,
            },
            {
              toolName: "financeGroupByMerchant",
              input: {
                document_type: "cc_statement",
                doc_ids: docIds,
                date_start: range.date_start,
                date_end: range.date_end,
                amount_min: 0.01,
                ...(wantsGroceries ? { categories_in: ["groceries"] } : {}),
              },
              output: grouped,
            },
          ],
          citations: [],
          confidence: total.count === 0 ? "low" : "medium",
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
      const wantsSpendSearch =
        (q.includes("was there") || q.includes("did i") || q.includes("do i have")) &&
        (q.includes("fee") || q.includes("charge") || q.includes("charges") || q.includes("spent") || q.includes("spend"));

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
              "Income is computed as bank-statement deposits (amount > 0) to Personal accounts, excluding transfers and payments made to credit card accounts.",
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

      // Fallback: business spend search by description (when model output is empty/invalid).
      if (wantsBusinessOnly && isSpendLike && wantsSpendSearch) {
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

        const term = inferSearchTermFromText(parsed.question);

        if (!entityName) {
          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: "",
            questions_for_user: [
              businessNames.length > 0
                ? `Which business should I search? (${businessNames.join(", ")})`
                : "Which business should I search?",
            ],
            assumptions: [],
            tool_calls: [],
            citations: [],
            confidence: "low",
          });
        }

        if (!term || !(typeof year === "number" && Number.isFinite(year))) {
          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: "",
            questions_for_user: [
              "What exact description should I search for? (You can put it in quotes, e.g. \"RENEWAL MEMBERSHIP FEE\".)",
            ],
            assumptions: [],
            tool_calls: [],
            citations: [],
            confidence: "low",
          });
        }

        const date_start = `${year}-01-01`;
        const date_end = `${year + 1}-01-01`;

        const list = await financeList({
          userId: session.user.id,
          projectId: parsed.projectId,
          documentType: "cc_statement",
          filters: {
            entity_kind: "business",
            entity_name: entityName,
            vendor_contains: term,
            date_start,
            date_end,
          },
        });

        const rowsAny: unknown[] = list.query_type === "list" ? (list.rows as unknown[]) : [];
        const isTxnRow = (row: unknown): row is { txnDate: string; description: string | null; amount: string } => {
          if (!row || typeof row !== "object") return false;
          const r = row as Record<string, unknown>;
          return (
            typeof r.txnDate === "string" &&
            typeof r.amount === "string" &&
            (typeof r.description === "string" || r.description === null)
          );
        };

        const tableRows = rowsAny
          .filter(isTxnRow)
          .slice(0, 20)
          .map((r) => {
            const desc = typeof r.description === "string" ? r.description.trim() : "";
            return [r.txnDate, clipText(desc || "(no description)", 120), `$${r.amount}`];
          });
        const matchesTable =
          tableRows.length > 0 ? toGfmTable(["Date", "Description", "Amount"], tableRows) : "";

        const found = matchesTable.length > 0;
        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: found
            ? [
                `Yes — I found matching transactions for "${term}" in ${entityName} (${year}).`,
                "",
                "Matches:",
                matchesTable,
                "\n(Showing first 20 matches.)",
              ]
                .filter((s) => s.length > 0)
                .join("\n")
            : `No — I didn’t find any ${entityName} credit-card transactions in ${year} whose description matches "${term}".`,
          questions_for_user: [],
          assumptions: ["Matching is done by searching the transaction description field."],
          tool_calls: [
            {
              toolName: "financeList",
              input: {
                document_type: "cc_statement",
                entity_kind: "business",
                entity_name: entityName,
                vendor_contains: term,
                date_start,
                date_end,
              },
              output: list,
            },
          ],
          citations: [],
          confidence: found ? "medium" : "low",
        });
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
              "Income is computed as bank-statement deposits (amount > 0), excluding transfers and payments made to credit card accounts.",
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
