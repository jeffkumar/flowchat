import { generateText, tool } from "ai";
import type { Session } from "next-auth";
import { z } from "zod";
import { myProvider } from "@/lib/ai/providers";
import { financeQuery as financeQueryTool } from "@/lib/ai/tools/finance-query";
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
  chat_history: z.string().max(10_000).optional(),
  // Optional hints the frontline can pass
  projectId: z.string().uuid().optional(),
  entity_hint: z
    .object({
      entity_kind: z.enum(["personal", "business"]).optional(),
      entity_name: z.string().min(1).max(200).optional(),
    })
    .optional(),
  preferences: z
    .object({
      doc_type: z.enum(["cc_statement", "bank_statement"]).optional(),
      card_brand: z.enum(["amex"]).optional(),
      credit_card_only: z.boolean().optional(),
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

  const resolveEntityScope = async (): Promise<{ entity_kind: "personal" | "business"; entity_name: string } | null> => {
    const q = parsed.question.toLowerCase();
    const hintedKind = parsed.entity_hint?.entity_kind;
    const hintedName = parsed.entity_hint?.entity_name?.trim();

    // Always normalize personal to a stable name.
    const wantsPersonal = hintedKind === "personal" || q.includes("personal");
    const wantsBusiness = hintedKind === "business" || q.includes("business");

    if (wantsPersonal && !wantsBusiness) {
      return { entity_kind: "personal", entity_name: "Personal" };
    }

    const projectIdValue = parsed.projectId;
    if (!projectIdValue) {
      if (wantsBusiness && hintedName) {
        return { entity_kind: "business", entity_name: hintedName };
      }
      if (wantsPersonal) {
        return { entity_kind: "personal", entity_name: "Personal" };
      }
      return null;
    }

    const entityRows = await getProjectEntitySummaryForUser({
      userId: session.user.id,
      projectId: projectIdValue,
    });

    const businessNames: string[] = [];
    let hasPersonal = false;
    for (const row of entityRows) {
      if (row.entityKind === "personal") hasPersonal = true;
      if (row.entityKind !== "business") continue;
      if (typeof row.entityName !== "string") continue;
      const name = row.entityName.trim();
      if (name.length > 0) businessNames.push(name);
    }
    const uniqueBusinesses = Array.from(new Set(businessNames)).sort((a, b) => a.localeCompare(b));

    if (!wantsBusiness && hasPersonal && uniqueBusinesses.length === 0) {
      return { entity_kind: "personal", entity_name: "Personal" };
    }

    if (wantsBusiness) {
      if (hintedName && hintedName.length > 0) {
        return { entity_kind: "business", entity_name: hintedName };
      }
      const inferred = inferBusinessNameFromText(parsed.question, uniqueBusinesses);
      if (inferred) {
        return { entity_kind: "business", entity_name: inferred };
      }
      if (uniqueBusinesses.length === 1) {
        return { entity_kind: "business", entity_name: uniqueBusinesses[0] };
      }
      return null;
    }

    // No explicit personal/business: only auto-select if unambiguous.
    if (hasPersonal && uniqueBusinesses.length === 0) {
      return { entity_kind: "personal", entity_name: "Personal" };
    }
    if (!hasPersonal && uniqueBusinesses.length === 1) {
      return { entity_kind: "business", entity_name: uniqueBusinesses[0] };
    }
    if (hasPersonal && uniqueBusinesses.length === 1) {
      // Still ambiguous without user intent; ask.
      return null;
    }
    return null;
  };

  const resolvedEntityScope = await resolveEntityScope();
  if (!resolvedEntityScope) {
    const businessNames = await listBusinessEntityNames();
    const options = [
      "Personal",
      ...businessNames.map((n) => `Business: ${n}`),
    ];
    return SpecialistAgentResponseSchema.parse({
      kind: "finance",
      answer_draft: "",
      questions_for_user: [
        options.length > 0
          ? `Which entity should I use? (${options.join(", ")})`
          : "Which entity should I use (Personal or a specific business)?",
      ],
      assumptions: [],
      tool_calls: [],
      citations: [],
      confidence: "low",
    });
  }

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

  const parseCents = (amount: string): number | null => {
    const trimmed = amount.trim();
    const m = trimmed.match(/^(-)?(\d+)(?:\.(\d{1,2}))?$/);
    if (!m) return null;
    const neg = Boolean(m[1]);
    const dollars = Number(m[2]);
    const centsPart = m[3] ?? "0";
    const cents = Number(centsPart.padEnd(2, "0"));
    if (!Number.isFinite(dollars) || !Number.isFinite(cents)) return null;
    const value = dollars * 100 + cents;
    return neg ? -value : value;
  };

  const formatDollars = (cents: number): string => {
    const sign = cents < 0 ? "-" : "";
    const abs = Math.abs(cents);
    const dollars = Math.floor(abs / 100);
    const rem = String(abs % 100).padStart(2, "0");
    return `${sign}${dollars}.${rem}`;
  };

  const categorizeExpense = (description: string): string => {
    const d = description.toLowerCase();
    if (/\b(uber|lyft|taxi|rideshare|parking|toll|metro|transit|train)\b/.test(d)) {
      return "Transport";
    }
    if (/\b(hotel|airbnb|vrbo|flight|airlines|delta|united|american airlines|southwest|jetblue)\b/.test(d)) {
      return "Travel";
    }
    if (/\b(restaurant|cafe|coffee|starbucks|doordash|uber eats|grubhub|postmates|bar|brewery)\b/.test(d)) {
      return "Dining";
    }
    if (/\b(grocery|supermarket|market|trader joe|whole foods|safeway|kroger|costco)\b/.test(d)) {
      return "Groceries";
    }
    if (/\b(netflix|spotify|hulu|prime video|youtube|icloud|google one|dropbox|subscription|subscr)\b/.test(d)) {
      return "Subscriptions";
    }
    if (/\b(amazon|target|walmart|shop|store|retail|clothing|apparel)\b/.test(d)) {
      return "Shopping";
    }
    if (/\b(movie|cinema|theater|ticketmaster|stubhub|concert|show|museum|park|ski|resort|bowling|arcade)\b/.test(d)) {
      return "Entertainment";
    }
    if (/\b(gym|fitness|yoga|pilates|spa|massage)\b/.test(d)) {
      return "Fitness";
    }
    if (/\b(pharmacy|doctor|dentist|medical|hospital|clinic)\b/.test(d)) {
      return "Health";
    }
    return "Other";
  };

  const categorizeBusinessExpense = (description: string): string => {
    const d = description.toLowerCase();
    if (/\b(google workspace|gusto|quickbooks|xero|stripe|shopify|notion|figma|linear|github|aws|azure|gcp|openai|anthropic|slack|zoom)\b/.test(d)) {
      return "Software / SaaS";
    }
    if (/\b(ads|adwords|google ads|facebook|meta|instagram|tiktok|linkedin|twitter|x)\b/.test(d)) {
      return "Marketing / Ads";
    }
    if (/\b(consult|contract|freelance|agency|retainer|legal|attorney|law|accounting|cpa|bookkeep)\b/.test(d)) {
      return "Professional services";
    }
    if (/\b(uber|lyft|taxi|rideshare|parking|toll|metro|transit|train)\b/.test(d)) {
      return "Transport";
    }
    if (/\b(hotel|airbnb|vrbo|flight|airlines|delta|united|american airlines|southwest|jetblue)\b/.test(d)) {
      return "Travel";
    }
    if (/\b(restaurant|cafe|coffee|starbucks|doordash|uber eats|grubhub|postmates|meal)\b/.test(d)) {
      return "Meals";
    }
    if (/\b(hosting|domain|dns|mailgun|sendgrid|twilio)\b/.test(d)) {
      return "Infrastructure";
    }
    if (/\b(office|cowork|wework|supplies|staples|fedex|ups|usps|shipping|print)\b/.test(d)) {
      return "Office / Ops";
    }
    if (/\b(equipment|hardware|laptop|computer|monitor|camera|iphone|phone|electronics)\b/.test(d)) {
      return "Equipment";
    }
    if (/\b(tax|irs|franchise tax|state tax|fee)\b/.test(d)) {
      return "Taxes / fees";
    }
    return "Other";
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

  const prompt = `Conversation context (may be empty):
${parsed.chat_history ?? ""}

User question:
${parsed.question}

Hints:
${JSON.stringify({ entity_hint: resolvedEntityScope, time_hint: parsed.time_hint ?? null }, null, 2)}

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
      q.includes("deposit") ||
      q.includes("deposits") ||
      q.includes("bring in") ||
      q.includes("how much did i make") ||
      q.includes("how much did we make");
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
      const m = q.match(/\b(19\d{2}|20\d{2})-(\d{2})\b/);
      if (m) {
        const month = Number(m[2]);
        if (Number.isFinite(month) && month >= 1 && month <= 12) return month;
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
      q.includes("personal") || q.includes("personally") || resolvedEntityScope.entity_kind === "personal";
    const wantsBusiness = q.includes("business") || resolvedEntityScope.entity_kind === "business";

    // Personal income over a rolling window (e.g. "last 90 days", "past 3 weeks"): sum bank_statement deposits.
    const rollingDays = parseRollingWindowDays(parsed.question);

    // Personal spend over a rolling window (e.g. "last 90 days", "past 3 months").
    // Prefer bank-statement outflows (excluding transfers/cc payments) and optionally add cc charges.
    if (parsed.projectId && wantsPersonal && isSpendLike && typeof rollingDays === "number") {
      const dayMs = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const start = new Date(now - rollingDays * dayMs);
      const end = new Date(now + dayMs); // exclusive end = tomorrow (UTC)
      const date_start = start.toISOString().slice(0, 10);
      const date_end = end.toISOString().slice(0, 10);

      const docs = await getProjectDocsByProjectId({ projectId: parsed.projectId });
      const personalBankDocs = docs
        .filter((d) => d.documentType === "bank_statement")
        .filter((d) => d.entityKind === "personal");
      const personalCcDocs = docs
        .filter((d) => d.documentType === "cc_statement")
        .filter((d) => d.entityKind === "personal");

      const bankDocIds = personalBankDocs.map((d) => d.id);
      const ccDocIds = personalCcDocs.map((d) => d.id);

      if (bankDocIds.length === 0 && ccDocIds.length === 0) {
        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: "",
          questions_for_user: [
            `I don’t see any Personal bank or credit-card statements tagged Personal. Which statement(s) should I use to summarize your personal spend in the last ${rollingDays} days?`,
          ],
          assumptions: [],
          tool_calls: [],
          citations: [],
          confidence: "low",
        });
      }

      const bankFilters = {
        doc_ids: bankDocIds,
        date_start,
        date_end,
        amount_max: -0.01,
        exclude_categories: ["transfer", "credit card payment"],
      };

      const bankTotal = bankDocIds.length
        ? await financeSum({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType: "bank_statement",
            filters: bankFilters,
          })
        : { total: "0", count: 0 };

      const bankTop = bankDocIds.length
        ? await financeGroupByMerchant({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType: "bank_statement",
            filters: bankFilters,
          })
        : { rows: [] as unknown[] };

      const ccPos = ccDocIds.length
        ? await financeSum({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType: "cc_statement",
            filters: { doc_ids: ccDocIds, date_start, date_end, amount_min: 0.01 },
          })
        : { total: "0", count: 0 };

      const ccNeg =
        ccDocIds.length && ccPos.count === 0
          ? await financeSum({
              userId: session.user.id,
              projectId: parsed.projectId,
              documentType: "cc_statement",
              filters: { doc_ids: ccDocIds, date_start, date_end, amount_max: -0.01 },
            })
          : null;

      const ccUsed = ccNeg && ccPos.count === 0 ? ccNeg : ccPos;
      const ccToolInput =
        ccNeg && ccPos.count === 0
          ? { document_type: "cc_statement", doc_ids: ccDocIds, date_start, date_end, amount_max: -0.01 }
          : { document_type: "cc_statement", doc_ids: ccDocIds, date_start, date_end, amount_min: 0.01 };

      const topRows = Array.isArray((bankTop as any).rows) ? (bankTop as any).rows.slice(0, 15) : [];
      const topLines = topRows.map((r: any) => {
        const merchant = typeof r?.merchant === "string" && r.merchant.trim().length > 0 ? r.merchant.trim() : "(unknown)";
        const total = typeof r?.total === "string" ? r.total : "";
        const count = typeof r?.count === "number" ? r.count : null;
        return `- ${merchant}: ${total}${typeof count === "number" ? ` (${count} txns)` : ""}`;
      });

      const bankCount = typeof (bankTotal as any).count === "number" ? (bankTotal as any).count : 0;
      const ccCount = typeof (ccUsed as any).count === "number" ? (ccUsed as any).count : 0;

      return SpecialistAgentResponseSchema.parse({
        kind: "finance",
        answer_draft: [
          `Personal spending in the last ${rollingDays} days (${date_start} to ${date_end}):`,
          `- Bank outflows (excl transfers/cc payments): ${bankTotal.total} (rows: ${bankTotal.count})`,
          `- Credit-card charges: ${ccUsed.total} (rows: ${ccUsed.count})`,
          topLines.length > 0 ? "" : "",
          topLines.length > 0 ? "Top bank outflow descriptions:" : "",
          ...topLines,
        ]
          .filter((s) => s.length > 0)
          .join("\n"),
        questions_for_user: [],
        assumptions: [
          "Bank spend is computed as bank-statement outflows (amount < 0), excluding transfers and credit-card payments.",
          "Credit-card spend is computed from cc_statement charges; if positive-amount charges return 0 rows, a negative-amount convention is tried.",
          "The date range is computed in UTC; date_end is exclusive.",
        ],
        tool_calls: [
          {
            toolName: "financeSum",
            input: {
              document_type: "bank_statement",
              doc_ids: bankDocIds,
              date_start,
              date_end,
              amount_max: -0.01,
              exclude_categories: ["transfer", "credit card payment"],
            },
            output: bankTotal,
          },
          {
            toolName: "financeSum",
            input: ccToolInput,
            output: ccUsed,
          },
          {
            toolName: "financeGroupByMerchant",
            input: {
              document_type: "bank_statement",
              doc_ids: bankDocIds,
              date_start,
              date_end,
              amount_max: -0.01,
              exclude_categories: ["transfer", "credit card payment"],
            },
            output: bankTop,
          },
        ],
        citations: [],
        confidence: bankCount > 0 || ccCount > 0 ? "medium" : "low",
      });
    }

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

    // Personal income for a specific year (e.g. "income in 2025"): sum bank_statement deposits for that calendar year.
    if (parsed.projectId && wantsPersonal && isIncomeLike && typeof rollingDays !== "number" && !monthFromText) {
      const year =
        parsed.time_hint?.kind === "year"
          ? parsed.time_hint.year ?? null
          : inferYearFromText(parsed.question);

      if (typeof year === "number" && Number.isFinite(year)) {
        const date_start = `${year}-01-01`;
        const date_end = `${year + 1}-01-01`;

        const docs = await getProjectDocsByProjectId({ projectId: parsed.projectId });
        const personalBankDocs = docs
          .filter((d) => d.documentType === "bank_statement")
          .filter((d) => {
            if (d.entityKind === "personal") return true;
            const name = typeof d.entityName === "string" ? d.entityName.trim().toLowerCase() : "";
            return name === "personal";
          });
        const docIds = personalBankDocs.map((d) => d.id);

        if (docIds.length === 0) {
          const anyBank = docs
            .filter((d) => d.documentType === "bank_statement")
            .slice(0, 12)
            .map((d) => d.filename);
          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: "",
            questions_for_user: [
              anyBank.length > 0
                ? `I didn’t find any bank statements tagged Personal. Which statement should I use for your personal deposits in ${year}? (${anyBank.join("; ")})`
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

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: `Personal deposits in ${year} (${date_start} to ${date_end}): $${sum.total} (rows: ${sum.count}).`,
          questions_for_user:
            sum.count === 0
              ? ["I found 0 matching deposits in that year. Are your personal bank statements tagged Personal, or are they unassigned?"]
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
          ],
          citations: [],
          confidence: sum.count === 0 ? "low" : "medium",
        });
      }
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

    // Personal total spend for a specific month (e.g. "December 2025 personal").
    // Prefer bank-statement outflows (excluding transfers/cc payments) and optionally add cc charges.
    if (isSpendLike && wantsPersonal && monthFromText && parsed.projectId) {
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

        const parseMoneyToCents = (value: string): bigint | null => {
          const trimmed = value.trim();
          const m = trimmed.match(/^(-)?(\d+)(?:\.(\d{1,2}))?$/);
          if (!m) return null;
          const sign = m[1] ? -1n : 1n;
          const whole = BigInt(m[2] ?? "0");
          const fracRaw = m[3] ?? "0";
          const frac = BigInt(fracRaw.padEnd(2, "0"));
          return sign * (whole * 100n + frac);
        };

        const centsToMoney = (centsAbs: bigint): string => {
          const whole = centsAbs / 100n;
          const frac = centsAbs % 100n;
          return `${whole.toString()}.${frac.toString().padStart(2, "0")}`;
        };

        const docs = await getProjectDocsByProjectId({ projectId: parsed.projectId });
        const personalBankDocs = docs
          .filter((d) => d.documentType === "bank_statement")
          .filter((d) => d.entityKind === "personal");
        const personalCcDocs = docs
          .filter((d) => d.documentType === "cc_statement")
          .filter((d) => d.entityKind === "personal");

        const bankDocIds = personalBankDocs.map((d) => d.id);
        const ccDocIds = personalCcDocs.map((d) => d.id);

        const bank = bankDocIds.length
          ? await financeSum({
              userId: session.user.id,
              projectId: parsed.projectId,
              documentType: "bank_statement",
              filters: {
                doc_ids: bankDocIds,
                date_start,
                date_end,
                amount_max: -0.01,
                exclude_categories: ["transfer", "credit card payment"],
              },
            })
          : { total: "0", count: 0 };

        const ccPos = ccDocIds.length
          ? await financeSum({
              userId: session.user.id,
              projectId: parsed.projectId,
              documentType: "cc_statement",
              filters: {
                doc_ids: ccDocIds,
                date_start,
                date_end,
                amount_min: 0.01,
              },
            })
          : { total: "0", count: 0 };

        const ccNeg =
          ccDocIds.length && ccPos.count === 0
            ? await financeSum({
                userId: session.user.id,
                projectId: parsed.projectId,
                documentType: "cc_statement",
                filters: {
                  doc_ids: ccDocIds,
                  date_start,
                  date_end,
                  amount_max: -0.01,
                },
              })
            : null;

        const ccUsed = ccNeg && ccPos.count === 0 ? ccNeg : ccPos;

        const bankCents = parseMoneyToCents(String(bank.total)) ?? 0n;
        const ccCents = parseMoneyToCents(String(ccUsed.total)) ?? 0n;
        const bankAbs = bankCents < 0n ? -bankCents : bankCents;
        const ccAbs = ccCents < 0n ? -ccCents : ccCents;
        const totalAbs = bankAbs + ccAbs;

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: [
            `Personal spending in ${year}-${mm}:`,
            `- Total: $${centsToMoney(totalAbs)}`,
            `- Bank outflows (excl transfers/cc payments): $${centsToMoney(bankAbs)} (rows: ${bank.count})`,
            `- Credit-card charges: $${centsToMoney(ccAbs)} (rows: ${ccUsed.count})`,
          ].join("\n"),
          questions_for_user:
            bankDocIds.length === 0 && ccDocIds.length === 0
              ? [
                  `I don’t see any Personal bank or credit-card statements tagged Personal for ${year}-${mm}. Which statement(s) should I use?`,
                ]
              : [],
          assumptions: [
            "Bank spend is computed as bank-statement outflows (amount < 0), excluding transfers and credit-card payments.",
            "Credit-card spend is computed from cc_statement charges; if positive-amount charges return 0 rows, a negative-amount convention is tried and reported as an absolute value.",
          ],
          tool_calls: [
            {
              toolName: "financeSum",
              input: {
                document_type: "bank_statement",
                doc_ids: bankDocIds,
                date_start,
                date_end,
                amount_max: -0.01,
                exclude_categories: ["transfer", "credit card payment"],
              },
              output: bank,
            },
            {
              toolName: "financeSum",
              input: {
                document_type: "cc_statement",
                doc_ids: ccDocIds,
                date_start,
                date_end,
                amount_min: 0.01,
              },
              output: ccUsed,
            },
          ],
          citations: [],
          confidence:
            (bankDocIds.length > 0 || ccDocIds.length > 0) &&
            ((typeof (bank as any).count === "number" && (bank as any).count > 0) ||
              (typeof (ccUsed as any).count === "number" && (ccUsed as any).count > 0))
              ? "medium"
              : "low",
        });
      }
    }

    // Personal bank outflows breakdown for a specific month.
    if (wantsPersonal && monthFromText && parsed.projectId) {
      const wantsBankOutflows =
        q.includes("bank outflows") ||
        (q.includes("bank") &&
          (q.includes("outflow") ||
            q.includes("outflows") ||
            q.includes("transactions") ||
            q.includes("spent on") ||
            q.includes("what i spent on") ||
            q.includes("what did i spend on")));

      if (wantsBankOutflows) {
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
          const personalBankDocs = docs
            .filter((d) => d.documentType === "bank_statement")
            .filter((d) => d.entityKind === "personal");
          const bankDocIds = personalBankDocs.map((d) => d.id);

          if (bankDocIds.length === 0) {
            return SpecialistAgentResponseSchema.parse({
              kind: "finance",
              answer_draft: "",
              questions_for_user: [
                `I don’t see any Personal bank statements tagged Personal for ${year}-${mm}. Which bank statement should I use?`,
              ],
              assumptions: [],
              tool_calls: [],
              citations: [],
              confidence: "low",
            });
          }

          const filters = {
            doc_ids: bankDocIds,
            date_start,
            date_end,
            amount_max: -0.01,
            exclude_categories: ["transfer", "credit card payment"],
          };

          const total = await financeSum({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType: "bank_statement",
            filters,
          });

          const grouped = await financeGroupByMerchant({
            userId: session.user.id,
            projectId: parsed.projectId,
            documentType: "bank_statement",
            filters,
          });

          const rows = Array.isArray(grouped.rows) ? grouped.rows : [];
          const topRows = rows.slice(0, 20);
          const lines = topRows.map((r) => {
            const merchant =
              typeof r.merchant === "string" && r.merchant.trim().length > 0
                ? r.merchant.trim()
                : "(unknown)";
            return `- ${merchant}: ${r.total} (${r.count} txns)`;
          });

          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: [
              `Personal bank outflows for ${year}-${mm} (excluding transfers and credit-card payments):`,
              `- Total: ${total.total}`,
              `- Transactions: ${total.count}`,
              "",
              "Top descriptions by outflow:",
              ...lines,
            ].join("\n"),
            questions_for_user: [],
            assumptions: [
              "Outflows are bank-statement transactions with amount < 0.",
              'Transfers and "credit card payment" categories are excluded.',
              "Descriptions are grouped verbatim.",
            ],
            tool_calls: [
              {
                toolName: "financeSum",
                input: {
                  document_type: "bank_statement",
                  doc_ids: bankDocIds,
                  date_start,
                  date_end,
                  amount_max: -0.01,
                  exclude_categories: ["transfer", "credit card payment"],
                },
                output: total,
              },
              {
                toolName: "financeGroupByMerchant",
                input: {
                  document_type: "bank_statement",
                  doc_ids: bankDocIds,
                  date_start,
                  date_end,
                  amount_max: -0.01,
                  exclude_categories: ["transfer", "credit card payment"],
                },
                output: grouped,
              },
            ],
            citations: [],
            confidence: total.count === 0 ? "low" : "medium",
          });
        }
      }
    }

    // Personal spend summary: use transaction description via group_by_merchant (merchant=description for statements).
    if (wantsSummary && isSpendLike && wantsPersonal && parsed.projectId) {
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

    // "Waste" (personal) by category: deterministic categorization using transaction descriptions.
    if (
      parsed.projectId &&
      resolvedEntityScope.entity_kind === "personal" &&
      q.includes("waste") &&
      (q.includes("category") || q.includes("categories")) &&
      parsed.time_hint?.kind === "year" &&
      typeof parsed.time_hint.year === "number" &&
      Number.isFinite(parsed.time_hint.year)
    ) {
      const year = parsed.time_hint.year;
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
            `I don’t see any personal credit-card statements tagged Personal yet. Which statement should I use to categorize ${year} spend?`,
          ],
          assumptions: [],
          tool_calls: [],
          citations: [],
          confidence: "low",
        });
      }

      const list = await financeList({
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

      const isTxnRow = (
        row: (typeof list.rows)[number]
      ): row is (typeof list.rows)[number] & { description: string | null; amount: string } => {
        if (typeof row !== "object" || row === null) return false;
        const r = row as Record<string, unknown>;
        return (
          typeof r.amount === "string" &&
          (typeof r.description === "string" || r.description === null)
        );
      };

      const rows = list.query_type === "list" ? list.rows.filter(isTxnRow) : [];
      const totals = new Map<string, number>();
      for (const r of rows) {
        const amtCents = parseCents(r.amount);
        if (amtCents === null) continue;
        const desc = typeof r.description === "string" ? r.description : "";
        const cat = categorizeExpense(desc);
        totals.set(cat, (totals.get(cat) ?? 0) + amtCents);
      }

      const sorted = Array.from(totals.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([cat, cents]) => `- ${cat}: $${formatDollars(cents)}`);

      return SpecialistAgentResponseSchema.parse({
        kind: "finance",
        answer_draft: [
          `${year} personal spend, organized by category (heuristic from transaction descriptions):`,
          "",
          ...sorted,
        ].join("\n"),
        questions_for_user: [],
        assumptions: [
          "Categories are heuristic (derived from transaction descriptions), not issuer-provided categories.",
          "Spend is computed as positive cc_statement amounts (amount > 0).",
        ],
        tool_calls: [
          {
            toolName: "financeList",
            input: {
              document_type: "cc_statement",
              doc_ids: docIds,
              date_start: `${year}-01-01`,
              date_end: `${year + 1}-01-01`,
              amount_min: 0.01,
            },
            output: list,
          },
        ],
        citations: [],
        confidence: rows.length === 0 ? "low" : "medium",
      });
    }

    // Personal discretionary highlights (YTD/year): deterministic categorization using transaction descriptions.
    if (
      parsed.projectId &&
      resolvedEntityScope.entity_kind === "personal" &&
      (q.includes("discretion") || q.includes("discretionary") || q.includes("discretional"))
    ) {
      const year =
        parsed.time_hint?.kind === "year"
          ? parsed.time_hint.year ?? null
          : inferYearFromText(parsed.question) ?? new Date().getUTCFullYear();
      if (typeof year === "number" && Number.isFinite(year)) {
        const docs = await getProjectDocsByProjectId({ projectId: parsed.projectId });
        const mentionsAmex = q.includes("amex") || q.includes("american express");
        const personalCcDocs = docs
          .filter((d) => d.documentType === "cc_statement")
          .filter((d) => d.entityKind === "personal")
          .filter((d) => {
            if (!mentionsAmex) return true;
            return d.filename.toLowerCase().includes("amex");
          });

        const docIds = personalCcDocs.map((d) => d.id);
        if (docIds.length === 0) {
          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: "",
            questions_for_user: [
              mentionsAmex
                ? `I don’t see any personal Amex statements tagged Personal yet. Which statement should I use for ${year} discretionary spend?`
                : `I don’t see any personal credit-card statements tagged Personal yet. Which statement should I use for ${year} discretionary spend?`,
            ],
            assumptions: [],
            tool_calls: [],
            citations: [],
            confidence: "low",
          });
        }

        const list = await financeList({
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

        const isTxnRow = (
          row: (typeof list.rows)[number]
        ): row is (typeof list.rows)[number] & { description: string | null; amount: string } => {
          if (typeof row !== "object" || row === null) return false;
          const r = row as Record<string, unknown>;
          return (
            typeof r.amount === "string" &&
            (typeof r.description === "string" || r.description === null)
          );
        };

        const discretionaryCats = new Set([
          "Dining",
          "Travel",
          "Shopping",
          "Subscriptions",
          "Entertainment",
          "Fitness",
          "Transport",
        ]);

        const totalsByCat = new Map<string, number>();
        const totalsByDesc = new Map<string, { cents: number; count: number }>();
        let totalDiscretionary = 0;

        const rows = list.query_type === "list" ? list.rows.filter(isTxnRow) : [];
        for (const r of rows) {
          const cents = parseCents(r.amount);
          if (cents === null) continue;
          const desc = typeof r.description === "string" ? r.description.trim() : "";
          const cat = categorizeExpense(desc);
          if (!discretionaryCats.has(cat)) continue;

          totalDiscretionary += cents;
          totalsByCat.set(cat, (totalsByCat.get(cat) ?? 0) + cents);
          const key = desc.length > 0 ? desc : "(no description)";
          const prev = totalsByDesc.get(key);
          totalsByDesc.set(key, {
            cents: (prev?.cents ?? 0) + cents,
            count: (prev?.count ?? 0) + 1,
          });
        }

        const catLines = Array.from(totalsByCat.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([cat, cents]) => `- ${cat}: $${formatDollars(cents)}`);

        const topDesc = Array.from(totalsByDesc.entries())
          .sort((a, b) => b[1].cents - a[1].cents)
          .slice(0, 12)
          .map(([desc, v]) => `- ${desc}: $${formatDollars(v.cents)} (${v.count} txns)`);

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: [
            `${year} personal${mentionsAmex ? " Amex" : ""} discretionary highlights (heuristic from descriptions):`,
            `- Discretionary total: $${formatDollars(totalDiscretionary)}`,
            "",
            "By category:",
            ...(catLines.length > 0 ? catLines : ["- (none matched discretionary categories)"]),
            "",
            "Top discretionary descriptions by spend:",
            ...(topDesc.length > 0 ? topDesc : ["- (none)"]),
          ].join("\n"),
          questions_for_user: [],
          assumptions: [
            "Discretionary is inferred from descriptions; this is a heuristic, not accounting categorization.",
            "Spend is computed as positive cc_statement amounts (amount > 0).",
          ],
          tool_calls: [
            {
              toolName: "financeList",
              input: {
                document_type: "cc_statement",
                doc_ids: docIds,
                date_start: `${year}-01-01`,
                date_end: `${year + 1}-01-01`,
                amount_min: 0.01,
              },
              output: list,
            },
          ],
          citations: [],
          confidence: totalDiscretionary === 0 ? "low" : "medium",
        });
      }
    }

    // "Waste"/"discretionary" (business) by category: deterministic categorization using transaction descriptions.
    if (
      parsed.projectId &&
      resolvedEntityScope.entity_kind === "business" &&
      (q.includes("waste") || q.includes("discretion"))
    ) {
      const year =
        parsed.time_hint?.kind === "year"
          ? parsed.time_hint.year ?? null
          : inferYearFromText(parsed.question) ?? new Date().getUTCFullYear();
      if (typeof year === "number" && Number.isFinite(year)) {
        const docs = await getProjectDocsByProjectId({ projectId: parsed.projectId });
        const target = resolvedEntityScope.entity_name.trim().toLowerCase();

        const creditCardOnly =
          parsed.preferences?.credit_card_only === true ||
          parsed.preferences?.doc_type === "cc_statement" ||
          q.includes("credit card only") ||
          q.includes("card only");
        const mentionsAmex =
          parsed.preferences?.card_brand === "amex" ||
          q.includes("amex") ||
          q.includes("american express");

        const allCcDocs = docs.filter((d) => d.documentType === "cc_statement");
        const baseCcCandidates = (() => {
          if (!mentionsAmex) return allCcDocs;
          const amex = allCcDocs.filter((d) => d.filename.toLowerCase().includes("amex"));
          return amex.length > 0 ? amex : allCcDocs;
        })();
        const taggedToBusiness = baseCcCandidates
          .filter((d) => d.entityKind === "business")
          .filter((d) => (typeof d.entityName === "string" ? d.entityName.trim().toLowerCase() : "") === target);
        const nonPersonal = baseCcCandidates.filter((d) => d.entityKind !== "personal");
        const ccCandidates = taggedToBusiness.length > 0 ? taggedToBusiness : nonPersonal;
        const businessBankDocs = docs
          .filter((d) => d.documentType === "bank_statement")
          .filter((d) => d.entityKind === "business")
          .filter((d) => (typeof d.entityName === "string" ? d.entityName.trim().toLowerCase() : "") === target);

        const ccDocIds = ccCandidates.map((d) => d.id);
        const bankDocIds = businessBankDocs.map((d) => d.id);

        if (ccDocIds.length === 0 && (!creditCardOnly && bankDocIds.length === 0)) {
          return SpecialistAgentResponseSchema.parse({
            kind: "finance",
            answer_draft: "",
            questions_for_user: [
              `I don’t see any business statements tagged "${resolvedEntityScope.entity_name}" yet. Which business bank/credit-card statement should I use?`,
            ],
            assumptions: [],
            tool_calls: [],
            citations: [],
            confidence: "low",
          });
        }

        if (creditCardOnly) {
          if (ccCandidates.length > 1) {
            const options = ccCandidates.slice(0, 10).map((d) => d.filename);
            return SpecialistAgentResponseSchema.parse({
              kind: "finance",
              answer_draft: "",
              questions_for_user: [
                `Which ${resolvedEntityScope.entity_name} credit-card statement should I use for ${year} spend? (${options.join(", ")})`,
              ],
              assumptions: [],
              tool_calls: [],
              citations: [],
              confidence: "low",
            });
          }
          if (ccCandidates.length === 0) {
            return SpecialistAgentResponseSchema.parse({
              kind: "finance",
              answer_draft: "",
              questions_for_user: [
                `I don’t see any ${resolvedEntityScope.entity_name} credit-card statements that match your request. Which statement should I use?`,
              ],
              assumptions: [],
              tool_calls: [],
              citations: [],
              confidence: "low",
            });
          }
        }

        const ccList =
          ccDocIds.length > 0
            ? await financeList({
                userId: session.user.id,
                projectId: parsed.projectId,
                documentType: "cc_statement",
                filters: {
                  doc_ids: ccDocIds,
                  date_start: `${year}-01-01`,
                  date_end: `${year + 1}-01-01`,
                  amount_min: 0.01,
                },
              })
            : null;

        const bankList =
          creditCardOnly
            ? null
            : bankDocIds.length > 0
              ? await financeList({
                  userId: session.user.id,
                  projectId: parsed.projectId,
                  documentType: "bank_statement",
                  filters: {
                    doc_ids: bankDocIds,
                    date_start: `${year}-01-01`,
                    date_end: `${year + 1}-01-01`,
                    amount_max: -0.01,
                    exclude_categories: ["transfer", "credit card payment"],
                  },
                })
              : null;

        const discretionaryCats = new Set(["Meals", "Travel", "Marketing / Ads", "Office / Ops"]);
        const discretionaryTotals = new Map<string, number>();
        const addDiscretionary = (cat: string, cents: number) => {
          if (!discretionaryCats.has(cat)) return;
          discretionaryTotals.set(cat, (discretionaryTotals.get(cat) ?? 0) + cents);
        };
        const isDiscretionaryRequest = q.includes("discretion") || q.includes("discretionary");

        const isTxnRow = (
          row: unknown
        ): row is { description: string | null; amount: string } => {
          if (typeof row !== "object" || row === null) return false;
          const r = row as Record<string, unknown>;
          return (
            typeof r.amount === "string" &&
            (typeof r.description === "string" || r.description === null)
          );
        };

        const totals = new Map<string, number>();
        const merchants = new Map<string, number>();
        const ingestRows = (rows: Array<{ description: string | null; amount: string }>) => {
          for (const r of rows) {
            const amtCents = parseCents(r.amount);
            if (amtCents === null) continue;
            const abs = Math.abs(amtCents);
            const desc = typeof r.description === "string" ? r.description : "";
            const cat = categorizeBusinessExpense(desc);
            totals.set(cat, (totals.get(cat) ?? 0) + abs);
            addDiscretionary(cat, abs);
            const key = desc.trim().length > 0 ? desc.trim() : "(no description)";
            merchants.set(key, (merchants.get(key) ?? 0) + abs);
          }
        };

        if (ccList?.query_type === "list" && Array.isArray(ccList.rows)) {
          ingestRows(ccList.rows.filter(isTxnRow) as Array<{ description: string | null; amount: string }>);
        }
        if (bankList?.query_type === "list" && Array.isArray(bankList.rows)) {
          ingestRows(bankList.rows.filter(isTxnRow) as Array<{ description: string | null; amount: string }>);
        }

        const categoryLines = Array.from(totals.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([cat, cents]) => `- ${cat}: $${formatDollars(cents)}`);

        const discretionaryLines = Array.from(discretionaryTotals.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([cat, cents]) => `- ${cat}: $${formatDollars(cents)}`);

        const topMerchants = Array.from(merchants.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([m, cents]) => `- ${m}: $${formatDollars(cents)}`);

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: [
            `${year} business spend for ${resolvedEntityScope.entity_name}${mentionsAmex ? " (Amex)" : ""}${creditCardOnly ? " (credit card only)" : ""}, organized by category (heuristic from descriptions):`,
            "",
            ...(isDiscretionaryRequest && discretionaryLines.length > 0
              ? ["Discretionary candidates (heuristic):", ...discretionaryLines, ""]
              : []),
            ...categoryLines,
            "",
            "Top descriptions by spend:",
            ...topMerchants,
          ].join("\n"),
          questions_for_user: [],
          assumptions: [
            "Categories are heuristic (derived from transaction descriptions), not accounting categories.",
            creditCardOnly
              ? "Business spend includes credit-card charges (amount > 0) only."
              : "Business spend includes credit-card charges (amount > 0) and bank withdrawals (amount < 0) excluding transfers and credit-card payments.",
          ],
          tool_calls: [
            ...(ccList
              ? [
                  {
                    toolName: "financeList",
                    input: {
                      document_type: "cc_statement",
                      doc_ids: ccDocIds,
                      date_start: `${year}-01-01`,
                      date_end: `${year + 1}-01-01`,
                      amount_min: 0.01,
                    },
                    output: ccList,
                  },
                ]
              : []),
            ...(bankList
              ? [
                  {
                    toolName: "financeList",
                    input: {
                      document_type: "bank_statement",
                      doc_ids: bankDocIds,
                      date_start: `${year}-01-01`,
                      date_end: `${year + 1}-01-01`,
                      amount_max: -0.01,
                      exclude_categories: ["transfer", "credit card payment"],
                    },
                    output: bankList,
                  },
                ]
              : []),
          ],
          citations: [],
          confidence: totals.size === 0 ? "low" : "medium",
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

        return SpecialistAgentResponseSchema.parse({
          kind: "finance",
          answer_draft: wantsBusiness && entityName
            ? `You spent $${total} on ${entityName}${mentionsAmex ? " Amex" : ""} in ${year}-${mm}${signNote}.`
            : `You spent $${total} on your personal credit card${mentionsAmex ? " (Amex)" : ""} in ${year}-${mm}${signNote}.`,
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

  const financeQueryInputSchema = z.object({
    query_type: z.enum(["sum", "list", "group_by_month", "group_by_merchant"]),
    document_type: z.enum(["bank_statement", "cc_statement", "invoice"]),
    fallback_to_invoice_if_empty: z.boolean().optional(),
    time_window: z
      .object({
        kind: z.enum(["year", "month"]),
        year: z.number().int().min(1900).max(2200).optional(),
        month: z.number().int().min(1).max(12).optional(),
      })
      .optional(),
    filters: z
      .object({
        doc_ids: z.array(z.string().uuid()).optional(),
        date_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        date_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        vendor_contains: z.string().min(1).max(200).optional(),
        sender_contains: z.string().min(1).max(200).optional(),
        recipient_contains: z.string().min(1).max(200).optional(),
        amount_min: z.number().finite().optional(),
        amount_max: z.number().finite().optional(),
        entity_kind: z.enum(["personal", "business"]).optional(),
        entity_name: z.string().min(1).max(200).optional(),
        exclude_categories: z.array(z.string().min(1).max(64)).max(10).optional(),
      })
      .optional(),
  });

  const financeQueryScoped = tool({
    description:
      "Run deterministic finance queries over parsed financial documents (scoped to the resolved entity).",
    inputSchema: financeQueryInputSchema,
    execute: async (input) => {
      const base = input.filters ?? {};
      const scoped = {
        ...input,
        filters: {
          ...base,
          entity_kind: resolvedEntityScope.entity_kind,
          entity_name: resolvedEntityScope.entity_name,
        },
      };
      const underlying = financeQueryTool({ session, projectId: parsed.projectId }) as unknown as {
        execute?: (args: unknown, context: unknown) => Promise<unknown>;
      };
      if (typeof underlying.execute !== "function") {
        return { error: "financeQuery tool is unavailable" };
      }
      return await underlying.execute(scoped, {});
    },
  });

  const result = await generateText({
    model,
    system,
    prompt,
    maxRetries: 1,
    tools: {
      financeQuery: financeQueryScoped,
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
      const wantsBusinessOnly = q.includes("business") && !q.includes("personal") && !q.includes("combined");
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
