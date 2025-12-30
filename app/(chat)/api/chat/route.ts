import { geolocation } from "@vercel/functions";
import {
  convertToModelMessages,
  createUIMessageStream,
  generateText,
  JsonToSseTransformStream,
  smoothStream,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { unstable_cache as cache } from "next/cache";
import { after } from "next/server";
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from "resumable-stream";
import type { ModelCatalog } from "tokenlens/core";
import { fetchModels } from "tokenlens/fetch";
import { getUsage } from "tokenlens/helpers";
import { z } from "zod";
import { auth, type UserType } from "@/app/(auth)/auth";
import type { VisibilityType } from "@/lib/types";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import type { ChatModel } from "@/lib/ai/models";
import { type RequestHints, systemPrompt } from "@/lib/ai/prompts";
import { myProvider } from "@/lib/ai/providers";
import { decideFrontlineRouting } from "@/lib/ai/agents/frontline-agent";
import { runFinanceAgent } from "@/lib/ai/agents/finance-agent";
import { runProjectAgent } from "@/lib/ai/agents/project-agent";
import { runCitationsAgent } from "@/lib/ai/agents/citations-agent";
import { createDocument } from "@/lib/ai/tools/create-document";
import { financeQuery } from "@/lib/ai/tools/finance-query";
import { getWeather } from "@/lib/ai/tools/get-weather";
import { requestSuggestions } from "@/lib/ai/tools/request-suggestions";
import { updateDocument } from "@/lib/ai/tools/update-document";
import { isProductionEnvironment } from "@/lib/constants";
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  getOrCreateDefaultProjectForUser,
  getProjectByIdForUser,
  saveChat,
  saveMessages,
  updateChatLastContextById,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { ChatSDKError } from "@/lib/errors";
import {
  inferSourceTypeFromNamespace,
  namespacesForSourceTypes,
  type SourceType,
} from "@/lib/rag/source-routing";
import {
  formatRetrievedContext,
  queryTurbopuffer,
} from "@/lib/rag/turbopuffer";
import type { ChatMessage } from "@/lib/types";
import type { AppUsage } from "@/lib/usage";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 60;

let globalStreamContext: ResumableStreamContext | null = null;

type RetrievalRangePreset = "all" | "1d" | "7d" | "30d" | "90d";

type RelativeDay = "today" | "yesterday" | "dayBeforeYesterday";

const TIME_RANGE_HINT_RE =
  /\b(last|past|yesterday|today|since|between|from|in the last|\d+\s*(day|week|month|year)s?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2})\b/i;

// Heuristic: aggregation questions need more coverage across many docs (e.g. "sum across 30 invoices").
const AGGREGATION_HINT_RE =
  /\b(sum|total|add\s+up|aggregate|roll\s*up|grand\s+total)\b|\b(invoices?|receipts?)\b|\b(by|per|each)\s+month\b|\bmonthly\b|\bacross\s+\d+\b|\b(income|deposits?|revenue|bring\s+in|made|paid)\b/i;

const INCOME_INTENT_RE =
  /\b(how\s+much\s+did\s+i\s+make|how\s+much\s+did\s+we\s+make|how\s+much\s+did\s+we\s+bring\s+in|bring\s+in|income|deposits?|revenue|made|paid)\b/i;

const SPEND_INTENT_RE = /\b(spend|spent|spending|expense|expenses|charges?|rent|mortgage|lease)\b/i;

const INVOICE_REVENUE_RE = /\binvoice\s+revenue\b/i;

function startMsForPreset(preset: RetrievalRangePreset | undefined, nowMs: number) {
  if (!preset || preset === "all") {
    return null;
  }
  const dayMs = 24 * 60 * 60 * 1000;
  if (preset === "1d") return nowMs - 1 * dayMs;
  if (preset === "7d") return nowMs - 7 * dayMs;
  if (preset === "30d") return nowMs - 30 * dayMs;
  if (preset === "90d") return nowMs - 90 * dayMs;
  return null;
}

type WeekdayToken = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

type WeekdayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun ... 6=Sat

type TimeWindowKind =
  | "none"
  | "preset"
  | "relativeDay"
  | "absoluteDate"
  | "lastWeekday"
  | "lastWeekSegment";

type TimeWindowIntent =
  | { kind: "none"; matchedText?: string }
  | { kind: "preset"; preset: RetrievalRangePreset; matchedText?: string }
  | { kind: "relativeDay"; relativeDay: RelativeDay; matchedText?: string }
  | {
      kind: "absoluteDate";
      month: number;
      day: number;
      year?: number;
      matchedText?: string;
    }
  | { kind: "lastWeekday"; weekday: WeekdayToken; matchedText?: string }
  | {
      kind: "lastWeekSegment";
      segment: "wed-sun" | "thu-sat";
      matchedText?: string;
    };

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripMatchedText(fullText: string, matchedText: string | undefined) {
  const needle = typeof matchedText === "string" ? matchedText.trim() : "";
  if (!needle) return fullText;
  const re = new RegExp(escapeRegExp(needle), "gi");
  return fullText.replace(re, " ").replace(/\s+/g, " ").trim();
}

function messageContentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  // AI SDK / OpenAI provider can represent multimodal content as an array of parts.
  // Baseten chat completions currently only support plain text content.
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        textParts.push(p.text);
      } else if (p.type === "input_text" && typeof p.text === "string") {
        textParts.push(p.text);
      }
    }
    return textParts.join("\n").trim();
  }

  return "";
}

function coerceMessagesToTextOnly(messages: unknown[]): unknown[] {
  return messages
    .map((m) => {
      if (!m || typeof m !== "object") return null;
      const msg = m as Record<string, unknown>;
      const role = msg.role;
      if (role !== "user" && role !== "assistant" && role !== "system") {
        return null;
      }
      const content = messageContentToText(msg.content);
      // Drop messages that become empty after stripping non-text parts.
      if (!content) return null;
      return { ...msg, content };
    })
    .filter((m) => m !== null);
}

function hasNonImageFileParts(messages: unknown[]): boolean {
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const msg = m as Record<string, unknown>;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type !== "file") continue;
      const mediaType = p.mediaType;
      if (typeof mediaType !== "string") return true;
      if (!mediaType.startsWith("image/")) {
        return true;
      }
    }
  }
  return false;
}

type RetrievalTimeFilterMode = "sourceCreatedAtMs" | "rowTimestamp";

function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function getRetrievalTimeFilterModeInfoForProject(projectId: string | undefined): {
  mode: RetrievalTimeFilterMode;
  defaultMode: RetrievalTimeFilterMode;
  projectAllowlisted: boolean;
} {
  // NOTE: We ultimately want all sources to populate `sourceCreatedAtMs` so Turbopuffer can
  // do server-side filtering. Until then, allow per-project fallback to row timestamps (`ts`).
  const defaultMode: RetrievalTimeFilterMode =
    process.env.RETRIEVAL_TIME_FILTER_MODE === "rowTimestamp"
      ? "rowTimestamp"
      : "sourceCreatedAtMs";
  const allowlist = parseCsvEnv(process.env.RETRIEVAL_ROW_TIMESTAMP_PROJECT_IDS);
  const projectAllowlisted = Boolean(projectId && allowlist.includes(projectId));
  const mode: RetrievalTimeFilterMode = projectAllowlisted ? "rowTimestamp" : defaultMode;
  return { mode, defaultMode, projectAllowlisted };
}

function getZonedParts(utcMs: number, timeZone: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const value = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "NaN");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function zonedDateTimeToUtcMs({
  year,
  month,
  day,
  hour,
  minute,
  second,
  timeZone,
}: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  timeZone: string;
}) {
  // Iteratively solve for the UTC instant that renders to the desired local time in `timeZone`.
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const desiredLocalMs = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 3; i += 1) {
    const actual = getZonedParts(utcMs, timeZone);
    const actualLocalMs = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const diff = desiredLocalMs - actualLocalMs;
    utcMs += diff;
    if (diff === 0) break;
  }
  return utcMs;
}

function startOfLocalDayUtcMs({
  year,
  month,
  day,
  timeZone,
}: {
  year: number;
  month: number;
  day: number;
  timeZone: string;
}) {
  return zonedDateTimeToUtcMs({
    year,
    month,
    day,
    hour: 0,
    minute: 0,
    second: 0,
    timeZone,
  });
}

function addDaysToYmd({ year, month, day }: { year: number; month: number; day: number }, days: number) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function windowForRelativeDay({
  nowMs,
  timeZone,
  which,
}: {
  nowMs: number;
  timeZone: string;
  which: RelativeDay;
}): { startMs: number; endMs: number } {
  const nowLocal = getZonedParts(nowMs, timeZone);
  const offsetDays =
    which === "today" ? 0 : which === "yesterday" ? -1 : -2;
  const target = addDaysToYmd(
    { year: nowLocal.year, month: nowLocal.month, day: nowLocal.day },
    offsetDays
  );
  const next = addDaysToYmd(target, 1);
  const startMs = startOfLocalDayUtcMs({ ...target, timeZone });
  const endMs = startOfLocalDayUtcMs({ ...next, timeZone });
  return { startMs, endMs };
}

function getZonedWeekdayIndex(utcMs: number, timeZone: string): WeekdayIndex | null {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" });
  const weekday =
    dtf.formatToParts(new Date(utcMs)).find((p) => p.type === "weekday")?.value ??
    "";
  const key = weekday.toLowerCase().slice(0, 3);
  if (key === "sun") return 0;
  if (key === "mon") return 1;
  if (key === "tue") return 2;
  if (key === "wed") return 3;
  if (key === "thu") return 4;
  if (key === "fri") return 5;
  if (key === "sat") return 6;
  return null;
}

function weekdayTokenToIndex(token: WeekdayToken): WeekdayIndex {
  if (token === "sun") return 0;
  if (token === "mon") return 1;
  if (token === "tue") return 2;
  if (token === "wed") return 3;
  if (token === "thu") return 4;
  if (token === "fri") return 5;
  return 6;
}

function windowForLastWeekday({
  nowMs,
  timeZone,
  targetDow,
}: {
  nowMs: number;
  timeZone: string;
  targetDow: WeekdayIndex;
}): { startMs: number; endMs: number } | null {
  const nowLocal = getZonedParts(nowMs, timeZone);
  const nowDow = getZonedWeekdayIndex(nowMs, timeZone);
  if (nowDow === null) return null;

  // "last Friday" means the previous Friday, not "today" if today is Friday.
  let deltaDays = (nowDow - targetDow + 7) % 7;
  if (deltaDays === 0) deltaDays = 7;

  const target = addDaysToYmd(
    { year: nowLocal.year, month: nowLocal.month, day: nowLocal.day },
    -deltaDays
  );
  const next = addDaysToYmd(target, 1);
  return {
    startMs: startOfLocalDayUtcMs({ ...target, timeZone }),
    endMs: startOfLocalDayUtcMs({ ...next, timeZone }),
  };
}

function windowForLastWeekSegment({
  nowMs,
  timeZone,
  startDow,
  endDow,
}: {
  nowMs: number;
  timeZone: string;
  startDow: WeekdayIndex;
  endDow: WeekdayIndex;
}): { startMs: number; endMs: number } | null {
  const nowLocal = getZonedParts(nowMs, timeZone);
  const nowDow = getZonedWeekdayIndex(nowMs, timeZone);
  if (nowDow === null) return null;

  // Find the previous occurrence of the segment's "endDow"
  let deltaToEnd = (nowDow - endDow + 7) % 7;
  if (deltaToEnd === 0) deltaToEnd = 7;

  const endDay = addDaysToYmd(
    { year: nowLocal.year, month: nowLocal.month, day: nowLocal.day },
    -deltaToEnd
  );

  const spanDays = ((endDow - startDow + 7) % 7) + 1; // inclusive span
  const startDay = addDaysToYmd(endDay, -(spanDays - 1));
  const endExclusive = addDaysToYmd(endDay, 1);

  return {
    startMs: startOfLocalDayUtcMs({ ...startDay, timeZone }),
    endMs: startOfLocalDayUtcMs({ ...endExclusive, timeZone }),
  };
}

function isValidYmd({
  year,
  month,
  day,
}: {
  year: number;
  month: number;
  day: number;
}): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() + 1 === month &&
    d.getUTCDate() === day
  );
}

function inferYearForMonthDay({
  nowMs,
  timeZone,
  month,
  day,
}: {
  nowMs: number;
  timeZone: string;
  month: number;
  day: number;
}): number | null {
  const nowLocal = getZonedParts(nowMs, timeZone);
  const candidate = nowLocal.year;
  if (!isValidYmd({ year: candidate, month, day })) {
    return null;
  }
  const candidateStart = startOfLocalDayUtcMs({
    year: candidate,
    month,
    day,
    timeZone,
  });
  // If the requested date hasn't happened yet this year (in local time), pick last year.
  if (candidateStart > nowMs) {
    const prev = candidate - 1;
    return isValidYmd({ year: prev, month, day }) ? prev : null;
  }
  return candidate;
}

function computeWindowFromIntent({
  intent,
  nowMs,
  timeZone,
}: {
  intent: TimeWindowIntent;
  nowMs: number;
  timeZone: string;
}): { startMs: number; endMs: number } | null {
  if (intent.kind === "relativeDay") {
    return windowForRelativeDay({ nowMs, timeZone, which: intent.relativeDay });
  }
  if (intent.kind === "lastWeekday") {
    return windowForLastWeekday({
      nowMs,
      timeZone,
      targetDow: weekdayTokenToIndex(intent.weekday),
    });
  }
  if (intent.kind === "lastWeekSegment") {
    if (intent.segment === "wed-sun") {
      return windowForLastWeekSegment({ nowMs, timeZone, startDow: 3, endDow: 0 });
    }
    return windowForLastWeekSegment({ nowMs, timeZone, startDow: 4, endDow: 6 });
  }
  if (intent.kind === "absoluteDate") {
    const year =
      typeof intent.year === "number" && Number.isFinite(intent.year)
        ? Math.floor(intent.year)
        : inferYearForMonthDay({
            nowMs,
            timeZone,
            month: intent.month,
            day: intent.day,
          });
    if (year === null) return null;
    if (!isValidYmd({ year, month: intent.month, day: intent.day })) return null;
    const startMs = startOfLocalDayUtcMs({
      year,
      month: intent.month,
      day: intent.day,
      timeZone,
    });
    const next = addDaysToYmd({ year, month: intent.month, day: intent.day }, 1);
    const endMs = startOfLocalDayUtcMs({ ...next, timeZone });
    return { startMs, endMs };
  }
  return null;
}

function validateTimeWindowIntent(intent: TimeWindowIntent): boolean {
  if (intent.kind === "none") return true;
  if (intent.kind === "preset") return true;
  if (intent.kind === "relativeDay") return true;
  if (intent.kind === "absoluteDate") return true;
  if (intent.kind === "lastWeekday") return true;
  if (intent.kind === "lastWeekSegment") return true;
  return false;
}

async function inferTimeWindowIntent({
  userText,
  requestedPreset,
}: {
  userText: string;
  requestedPreset: RetrievalRangePreset | undefined;
}): Promise<TimeWindowIntent> {
  let selected: TimeWindowIntent = { kind: "none" };

  const schema = z.object({
    kind: z.enum([
      "none",
      "preset",
      "relativeDay",
      "absoluteDate",
      "lastWeekday",
      "lastWeekSegment",
    ]),
    preset: z.enum(["all", "1d", "7d", "30d", "90d"]).optional(),
    relativeDay: z.enum(["today", "yesterday", "dayBeforeYesterday"]).optional(),
    month: z.number().int().min(1).max(12).optional(),
    day: z.number().int().min(1).max(31).optional(),
    year: z.number().int().min(1970).max(2100).optional(),
    weekday: z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]).optional(),
    segment: z.enum(["wed-sun", "thu-sat"]).optional(),
    matchedText: z.string().max(120).optional(),
  });

  await generateText({
    model: myProvider.languageModel("chat-model"),
    system:
      "Extract a time window intent for retrieval.\n" +
      "- If no time constraint is implied, choose kind='none'.\n" +
      "- If the user asks for a specific day window, choose kind='relativeDay' or kind='lastWeekday'.\n" +
      "- If the user asks for an absolute date like 'Dec 2nd', '12/2', or '2025-12-02', choose kind='absoluteDate' with month/day and optional year.\n" +
      "- If the user asks for 'end of last week' and implies a segment (e.g. Wed-Sun or Thu-Sat), choose kind='lastWeekSegment'.\n" +
      "- If the user asks for a broad range like 'last week' or 'past 30 days', choose kind='preset' with the closest broader preset.\n" +
      "- Provide matchedText as the smallest phrase to remove from the embedding query (optional).\n" +
      `- The UI requestedPreset is: ${requestedPreset ?? "none"}.\n` +
      "You MUST call the provided tool and nothing else.",
    messages: [{ role: "user", content: userText }],
    tools: {
      selectTimeWindow: tool({
        description: "Select a structured time window intent for retrieval.",
        inputSchema: schema,
        execute: async (input) => {
          const parsed = schema.safeParse(input);
          if (!parsed.success) {
            selected = { kind: "none" };
            return { kind: "none" as const };
          }

          const v = parsed.data;
          if (v.kind === "preset") {
            selected = { kind: "preset", preset: v.preset ?? "all", matchedText: v.matchedText };
          } else if (v.kind === "relativeDay" && v.relativeDay) {
            selected = {
              kind: "relativeDay",
              relativeDay: v.relativeDay,
              matchedText: v.matchedText,
            };
          } else if (v.kind === "absoluteDate" && v.month && v.day) {
            selected = {
              kind: "absoluteDate",
              month: v.month,
              day: v.day,
              year: v.year,
              matchedText: v.matchedText,
            };
          } else if (v.kind === "lastWeekday" && v.weekday) {
            selected = { kind: "lastWeekday", weekday: v.weekday, matchedText: v.matchedText };
          } else if (v.kind === "lastWeekSegment" && v.segment) {
            selected = { kind: "lastWeekSegment", segment: v.segment, matchedText: v.matchedText };
          } else {
            selected = { kind: "none", matchedText: v.matchedText };
          }

          if (!validateTimeWindowIntent(selected)) {
            selected = { kind: "none" };
          }
          return selected;
        },
      }),
    },
    toolChoice: { type: "tool", toolName: "selectTimeWindow" },
    temperature: 0,
    maxOutputTokens: 120,
    stopWhen: stepCountIs(1),
  });

  return selected;
}

function timestampMsFromRow(row: unknown): number | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const r = row as Record<string, unknown>;
  const sourceCreatedAtMs = r.sourceCreatedAtMs;
  if (typeof sourceCreatedAtMs === "number" && Number.isFinite(sourceCreatedAtMs)) {
    return sourceCreatedAtMs;
  }
  if (typeof sourceCreatedAtMs === "string" && sourceCreatedAtMs.length > 0) {
    const parsed = Number(sourceCreatedAtMs);
    if (Number.isFinite(parsed)) return parsed;
  }
  const ts = r.ts;
  if (typeof ts === "string" && ts.length > 0) {
    const parsedSeconds = Number(ts);
    if (Number.isFinite(parsedSeconds)) return Math.floor(parsedSeconds * 1000);
  }
  return null;
}

function extractLastMentionName(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match =
    normalized.match(
      /\bwhat did\s+(.+?)\s+last\s+(mention|say|talk about)\b/i
    ) ??
    normalized.match(/\bwhat was\s+the last thing\s+(.+?)\s+(mentioned|said)\b/i);
  const raw = match?.[1]?.trim();
  if (!raw) return null;
  // Strip trailing punctuation and common filler.
  const cleaned = raw.replace(/[?.!,;:]+$/g, "").trim();
  if (!cleaned) return null;
  return cleaned;
}

function formatNewestSlackMatch({
  name,
  row,
  tsMs,
}: {
  name: string;
  row: Record<string, unknown>;
  tsMs: number;
}): string {
  const userName = typeof row.user_name === "string" ? row.user_name : name;
  const channelName = typeof row.channel_name === "string" ? row.channel_name : "";
  const url = typeof row.url === "string" ? row.url : "";
  const content = typeof row.content === "string" ? row.content : "";
  const iso = new Date(tsMs).toISOString();
  const headerParts = [
    "Most recent Slack message (in retrieved set)",
    userName ? `author=${userName}` : "",
    channelName ? `channel=#${channelName}` : "",
    `at=${iso}`,
    url ? `url=${url}` : "",
  ].filter((p) => p.length > 0);
  return `${headerParts.join(" · ")}\n${content}`;
}

const getTokenlensCatalog = cache(
  async (): Promise<ModelCatalog | undefined> => {
    try {
      return await fetchModels();
    } catch (err) {
      console.warn(
        "TokenLens: catalog fetch failed, using default catalog",
        err
      );
      return; // tokenlens helpers will fall back to defaultCatalog
    }
  },
  ["tokenlens-catalog"],
  { revalidate: 24 * 60 * 60 } // 24 hours
);

export function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({
        waitUntil: after,
      });
    } catch (error: any) {
      if (error.message.includes("REDIS_URL")) {
        console.log(
          " > Resumable streams are disabled due to missing REDIS_URL"
        );
      } else {
        console.error(error);
      }
    }
  }

  return globalStreamContext;
}

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  try {
    const {
      id,
      message,
      selectedChatModel,
      selectedVisibilityType,
      projectId: providedProjectId,
      sourceTypes,
      ignoredDocIds,
      retrievalRangePreset,
      retrievalTimeZone,
    }: {
      id: string;
      message: ChatMessage;
      selectedChatModel: ChatModel["id"];
      selectedVisibilityType: VisibilityType;
      projectId?: string;
      sourceTypes?: Array<"slack" | "docs">;
      ignoredDocIds?: string[];
      retrievalRangePreset?: RetrievalRangePreset;
      retrievalTimeZone?: string;
    } = requestBody;

    const session = await auth();

    if (!session?.user) {
      return new ChatSDKError("unauthorized:chat").toResponse();
    }

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 24,
    });

    if (messageCount >= entitlementsByUserType[userType].maxMessagesPerDay) {
      return new ChatSDKError("rate_limit:chat").toResponse();
    }

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let activeProjectId: string;
    let isDefaultProject = false;

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatSDKError("forbidden:chat").toResponse();
      }
      // Only fetch messages if chat already exists
      messagesFromDb = await getMessagesByChatId({ id });

      if (chat.projectId) {
        activeProjectId = chat.projectId;
        const project = await getProjectByIdForUser({
          projectId: activeProjectId,
          userId: session.user.id,
        });
        isDefaultProject = project?.isDefault ?? false;
      } else {
        // Fallback for chats without projectId (should be rare after backfill)
        const defaultProject = await getOrCreateDefaultProjectForUser({
          userId: session.user.id,
        });
        activeProjectId = defaultProject.id;
        isDefaultProject = true;
      }
    } else {
      const title = await generateTitleFromUserMessage({
        message,
      });

      if (
        typeof providedProjectId === "string" &&
        providedProjectId.length > 0
      ) {
        const project = await getProjectByIdForUser({
          projectId: providedProjectId,
          userId: session.user.id,
        });

        if (!project) {
          return new ChatSDKError("not_found:database").toResponse();
        }
        activeProjectId = project.id;
        isDefaultProject = project.isDefault;
      } else {
        const defaultProject = await getOrCreateDefaultProjectForUser({
          userId: session.user.id,
        });
        activeProjectId = defaultProject.id;
        isDefaultProject = true;
      }

      await saveChat({
        id,
        userId: session.user.id,
        projectId: activeProjectId,
        title,
        visibility: selectedVisibilityType,
      });
      // New chat - no need to fetch messages, it's empty
    }

    const uiMessages = [...convertToUIMessages(messagesFromDb), message];

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      longitude,
      latitude,
      city,
      country,
    };

    // Build a best-effort query string from the user's text parts
    const userTextParts = message.parts.filter(
      (
        part
      ): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
        part.type === "text"
    );
    const userText = userTextParts
      .map((part) => part.text)
      .join("\n")
      .slice(0, 4000);

    let retrievedContext = "";
    let sources: any[] = [];

    // Finance questions should not depend on Turbopuffer retrieval.
    const skipRetrievalForFinance = AGGREGATION_HINT_RE.test(userText) || SPEND_INTENT_RE.test(userText);
    const shouldLogRetrieval = process.env.DEBUG_TURBOPUFFER === "1";

    if (userText && !skipRetrievalForFinance) {
      try {
        const inferDocLockFilenameHint = (text: string): string | null => {
          // Explicit filename mention (prefer this).
          const explicit = Array.from(
            text.matchAll(
              /(["'`])([^"'`\n]{1,160}\.(?:pdf|docx?|txt))\1|([^\s\n]{1,160}\.(?:pdf|docx?|txt))/gi
            )
          )
            .map((m) => (m[2] || m[3] || "").trim())
            .filter(Boolean);
          if (explicit.length > 0) {
            return explicit.at(-1)?.toLowerCase() ?? null;
          }

          // Heuristic: "just use the strategy doc" -> lock to docs with "strategy" in filename.
          const normalized = text.toLowerCase();
          const asksForOnly =
            normalized.includes("just use") ||
            normalized.includes("use only") ||
            normalized.includes("only use");
          if (asksForOnly && normalized.includes("strategy") && normalized.includes("doc")) {
            return "strategy";
          }

          return null;
        };

        const docLockFilenameHint = inferDocLockFilenameHint(userText);

        const nowMs = Date.now();
        const effectiveTimeZone =
          typeof retrievalTimeZone === "string" && retrievalTimeZone.length > 0
            ? retrievalTimeZone
            : "UTC";

        const requestedPreset = retrievalRangePreset;
        const timeFilterModeInfo = getRetrievalTimeFilterModeInfoForProject(activeProjectId);
        const timeFilterMode = timeFilterModeInfo.mode;

        const hasTimeHint = TIME_RANGE_HINT_RE.test(userText);
        const intent = hasTimeHint
          ? await inferTimeWindowIntent({ userText, requestedPreset: requestedPreset ?? "all" })
          : ({ kind: "none" } satisfies TimeWindowIntent);

        // Compute a calendar window first (relative day, last weekday, or segment). If none, fall back to preset.
        const window = computeWindowFromIntent({
          intent,
          nowMs,
          timeZone: effectiveTimeZone,
        });
        const effectivePreset: RetrievalRangePreset =
          window
            ? "all"
            : intent.kind === "preset"
              ? intent.preset
              : requestedPreset && requestedPreset !== "all"
                ? requestedPreset
                : "all";

        const requestedSourceTypes = (
          Array.isArray(sourceTypes) ? sourceTypes : undefined
        ) as SourceType[] | undefined;
        const effectiveSourceTypes = docLockFilenameHint
          ? (["docs"] satisfies SourceType[])
          : requestedSourceTypes;
        const namespaces = namespacesForSourceTypes(
          effectiveSourceTypes,
          activeProjectId,
          isDefaultProject
        );

        if (shouldLogRetrieval) {
          console.log("Chat Retrieval Debug:", {
            activeProjectId,
            isDefaultProject,
            namespaces,
            requestedSourceTypes: effectiveSourceTypes,
            ignoredDocIds,
            docLockFilenameHint,
            retrievalTimeIntent: intent,
            retrievalTimeFilterMode: timeFilterMode,
            retrievalTimeFilterModeDefault: timeFilterModeInfo.defaultMode,
            retrievalTimeFilterModeProjectAllowlisted: timeFilterModeInfo.projectAllowlisted,
            retrievalRangePreset: effectivePreset,
            retrievalRangePresetRequested: requestedPreset,
            retrievalTimeZone: effectiveTimeZone,
            retrievalRelativeDay: intent.kind === "relativeDay" ? intent.relativeDay : null,
          });
        }

        const presetStartMs = startMsForPreset(effectivePreset, nowMs);
        const rangeStartMs = window ? window.startMs : presetStartMs;
        const rangeEndMs = window ? window.endMs : nowMs;
        const rowTimestampTopK = 160;
        const perNamespaceTopK =
          timeFilterMode === "rowTimestamp" && rangeStartMs !== null
            ? rowTimestampTopK
            : 24;

        if (window) {
          const startLocal = new Intl.DateTimeFormat("en-US", {
            timeZone: effectiveTimeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(window.startMs));
          const endLocal = new Intl.DateTimeFormat("en-US", {
            timeZone: effectiveTimeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(window.endMs));
          if (shouldLogRetrieval) {
            console.log("Chat Retrieval Relative Day Window:", {
              retrievalRelativeDay:
                intent.kind === "relativeDay" ? intent.relativeDay : null,
              retrievalTimeZone: effectiveTimeZone,
              startLocal,
              endLocal,
              startMs: window.startMs,
              endMs: window.endMs,
            });
          }
        }

        const retrievalQuery = (() => {
          const cleaned = stripMatchedText(userText, intent.matchedText);
          return cleaned.length > 0 ? cleaned : userText;
        })();
        if (shouldLogRetrieval) {
          console.log("Chat Retrieval Query:", {
            userTextLength: userText.length,
            retrievalQueryLength: retrievalQuery.length,
            retrievalQueryPreview:
              retrievalQuery.length > 200 ? `${retrievalQuery.slice(0, 200)}…` : retrievalQuery,
          });
        }

        const queryNamespace = async ({
          ns,
          topK,
          includeSourceCreatedAtMsFilter,
        }: {
          ns: string;
          topK: number;
          includeSourceCreatedAtMsFilter: boolean;
        }) => {
          const filterParts: unknown[] = [];

          if (ignoredDocIds && ignoredDocIds.length > 0) {
            filterParts.push(["Not", ["doc_id", "In", ignoredDocIds]]);
          }

          if (includeSourceCreatedAtMsFilter && rangeStartMs !== null) {
            filterParts.push(["sourceCreatedAtMs", "Gte", rangeStartMs]);
            filterParts.push(["sourceCreatedAtMs", "Lt", rangeEndMs]);
          }

          const filters =
            filterParts.length === 0
              ? undefined
              : filterParts.length === 1
                ? filterParts[0]
                : ["And", filterParts];

          const nsRows = await queryTurbopuffer({
            query: retrievalQuery,
            topK,
            namespace: ns,
            filters,
          });

          const inferredSourceType = inferSourceTypeFromNamespace(ns);
          return nsRows.map((r) => ({
            ...r,
            sourceType:
              typeof (r as any).sourceType === "string"
                ? (r as any).sourceType
                : (inferredSourceType ?? ""),
          }));
        };

        const shouldUseSourceCreatedAtMsFilter =
          timeFilterMode === "sourceCreatedAtMs" && rangeStartMs !== null;

        let appliedTimeFilterMode: RetrievalTimeFilterMode = timeFilterMode;

        let rowsByNamespace = await Promise.all(
          namespaces.map(async (ns) =>
            queryNamespace({
              ns,
              topK: perNamespaceTopK,
              includeSourceCreatedAtMsFilter: shouldUseSourceCreatedAtMsFilter,
            })
          )
        );

        if (docLockFilenameHint) {
          const hint = docLockFilenameHint.toLowerCase();
          rowsByNamespace = rowsByNamespace.map((nsRows) =>
            nsRows.filter((row) => {
              const filename =
                typeof (row as any).filename === "string" ? (row as any).filename : "";
              return filename.toLowerCase().includes(hint);
            })
          );
        }

        // Auto-fallback: if server-side `sourceCreatedAtMs` filtering yields no candidates,
        // retry without that filter and rely on per-row timestamps (`ts`/`sourceCreatedAtMs`)
        // in the post-filter step. This avoids requiring per-project allowlisting.
        const initialRowsCount = rowsByNamespace.reduce((sum, nsRows) => sum + nsRows.length, 0);
        if (initialRowsCount === 0 && shouldUseSourceCreatedAtMsFilter) {
          appliedTimeFilterMode = "rowTimestamp";
          if (shouldLogRetrieval) {
            console.log("Chat Retrieval Time Filter Fallback:", {
              reason: "no_rows_with_sourceCreatedAtMs_filter",
              rangeStartMs,
              rangeEndMs,
              namespaces,
              topK: rowTimestampTopK,
            });
          }
          rowsByNamespace = await Promise.all(
            namespaces.map(async (ns) =>
              queryNamespace({
                ns,
                topK: rowTimestampTopK,
                includeSourceCreatedAtMsFilter: false,
              })
            )
          );
          if (docLockFilenameHint) {
            const hint = docLockFilenameHint.toLowerCase();
            rowsByNamespace = rowsByNamespace.map((nsRows) =>
              nsRows.filter((row) => {
                const filename =
                  typeof (row as any).filename === "string" ? (row as any).filename : "";
                return filename.toLowerCase().includes(hint);
              })
            );
          }
        }

        const fusedRows = rowsByNamespace.flat().sort((a, b) => {
          const da =
            typeof a.$dist === "number" ? a.$dist : Number.POSITIVE_INFINITY;
          const db =
            typeof b.$dist === "number" ? b.$dist : Number.POSITIVE_INFINITY;
          return da - db;
        });

        const timeFilteredRows =
          rangeStartMs === null
            ? fusedRows
            : fusedRows.filter((row) => {
                const tsMs = timestampMsFromRow(row);
                return tsMs !== null && tsMs >= rangeStartMs && tsMs < rangeEndMs;
              });

        if (shouldLogRetrieval) {
          console.log("Chat Retrieval Time Filter:", {
            retrievalRangePreset: effectivePreset,
            retrievalRangePresetRequested: requestedPreset,
            retrievalTimeFilterModeApplied: appliedTimeFilterMode,
            rangeStartMs,
            rangeEndMs,
            nowMs,
            fusedRowsCount: fusedRows.length,
            timeFilteredRowsCount: timeFilteredRows.length,
          });
        }

        const isAggregationQuery = AGGREGATION_HINT_RE.test(userText);

        const cappedRows: typeof timeFilteredRows = [];
        const docIdCounts = new Map<string, number>();
        const maxChunksPerDoc = isAggregationQuery ? 1 : 10;
        for (const row of timeFilteredRows) {
          const sourceType =
            typeof (row as any).sourceType === "string" ? (row as any).sourceType : "";
          if (sourceType === "docs") {
            const docId =
              typeof (row as any).doc_id === "string" ? (row as any).doc_id : null;
            if (docId) {
              const count = docIdCounts.get(docId) ?? 0;
              if (count >= maxChunksPerDoc) continue;
              docIdCounts.set(docId, count + 1);
            }
          }
          cappedRows.push(row);
        }

        const filteredRows = cappedRows.slice(0, isAggregationQuery ? 120 : 24);
        let usedRows = filteredRows.slice(0, isAggregationQuery ? 40 : 8);

        const lastMentionName = extractLastMentionName(userText);
        if (lastMentionName) {
          const needle = lastMentionName.toLowerCase();
          let bestRow: Record<string, unknown> | null = null;
          let bestTsMs = -1;

          for (const row of timeFilteredRows) {
            const r = row as Record<string, unknown>;
            const sourceType = typeof r.sourceType === "string" ? r.sourceType : "";
            if (sourceType !== "slack") continue;

            const userName = typeof r.user_name === "string" ? r.user_name : "";
            const userEmail = typeof r.user_email === "string" ? r.user_email : "";
            const matchesName =
              (userName && userName.toLowerCase().includes(needle)) ||
              (userEmail && userEmail.toLowerCase().includes(needle));
            if (!matchesName) continue;

            const tsMs = timestampMsFromRow(r);
            if (tsMs === null) continue;
            if (tsMs > bestTsMs) {
              bestTsMs = tsMs;
              bestRow = r;
            }
          }

          if (bestRow && bestTsMs > 0) {
            usedRows = [bestRow as any];
            retrievedContext = formatNewestSlackMatch({
              name: lastMentionName,
              row: bestRow,
              tsMs: bestTsMs,
            });
          }
        }

        sources = usedRows;
        // Debug logging: summarize retrieval results without dumping large payloads
        try {
          const truncatePreview = (value: unknown) => {
            if (typeof value !== "string") {
              return null;
            }
            const oneLine = value.replace(/\s+/g, " ").trim();
            return oneLine.length > 150 ? `${oneLine.slice(0, 150)}…` : oneLine;
          };
          const summarizeValue = (value: unknown) => {
            if (value === null) return null;
            if (typeof value === "string") {
              const oneLine = value.replace(/\s+/g, " ").trim();
              return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
            }
            if (typeof value === "number") return Number.isFinite(value) ? value : null;
            if (typeof value === "boolean") return value;
            if (Array.isArray(value)) {
              return { type: "array", length: value.length };
            }
            if (typeof value === "object") {
              return { type: "object" };
            }
            return { type: typeof value };
          };
          const summarizeRow = (row: unknown) => {
            if (!row || typeof row !== "object") {
              return { type: typeof row };
            }
            const r = row as Record<string, unknown>;
            const keys = Object.keys(r).sort();
            const attributes: Record<string, unknown> = {};

            let included = 0;
            for (const key of keys) {
              if (key === "content") continue;
              if (key === "vector") continue;
              if (key === "$dist") continue;
              attributes[key] = summarizeValue(r[key]);
              included += 1;
              if (included >= 40) break;
            }

            const content = typeof r.content === "string" ? r.content : "";
            return {
              keys,
              attributes,
              contentLength: content.length,
              contentPreview: truncatePreview(content),
            };
          };
          const byNamespaceCounts = rowsByNamespace.map((nsRows, i) => ({
            namespace: namespaces[i],
            rowsCount: nsRows.length,
          }));
          if (shouldLogRetrieval) {
            console.log("Turbopuffer retrieval succeeded", {
              queryLength: userText.length,
              requestedSourceTypes,
              namespaces,
              perNamespace: byNamespaceCounts,
              fusedRowsCount: fusedRows.length,
              selectedRowsCount: filteredRows.length,
              sample: filteredRows.slice(0, 12).map((r) => ({
                $dist:
                  typeof r.$dist === "number"
                    ? Number(r.$dist.toFixed(3))
                    : r.$dist,
                sourceType:
                  typeof (r as any).sourceType === "string"
                    ? (r as any).sourceType
                    : typeof (r as any).source === "string"
                      ? (r as any).source
                      : null,
                preview: truncatePreview((r as any).content),
                docId: typeof (r as any).doc_id === "string" ? (r as any).doc_id : null,
                url: typeof (r as any).url === "string" ? (r as any).url : null,
                filename:
                  typeof (r as any).filename === "string" ? (r as any).filename : null,
                blobUrl:
                  typeof (r as any).blob_url === "string" ? (r as any).blob_url : null,
                projectId:
                  typeof (r as any).project_id === "string" ? (r as any).project_id : null,
                sourceCreatedAtMs:
                  typeof (r as any).sourceCreatedAtMs === "number"
                    ? (r as any).sourceCreatedAtMs
                    : typeof (r as any).sourceCreatedAtMs === "string"
                      ? (r as any).sourceCreatedAtMs
                      : null,
                ts: typeof (r as any).ts === "string" ? (r as any).ts : null,
                channelName:
                  typeof (r as any).channel_name === "string"
                    ? (r as any).channel_name
                    : null,
                userName:
                  typeof (r as any).user_name === "string" ? (r as any).user_name : null,
                userEmail:
                  typeof (r as any).user_email === "string" ? (r as any).user_email : null,
                row: summarizeRow(r),
              })),
            });
          }
        } catch (_e) {
          // Ignore logging failures
        }
        if (!retrievedContext) {
          if (isAggregationQuery) {
            retrievedContext = usedRows
              .map((row, index) => {
                const contentValue = (row as any).content ?? "";
                const content = String(contentValue);
                const filename = typeof (row as any).filename === "string" ? (row as any).filename : "";
                const channel =
                  typeof (row as any).channel_name === "string" ? (row as any).channel_name : "";
                const header = filename ? filename : channel ? `#${channel}` : `result ${index + 1}`;
                const truncated = content.length > 700 ? `${content.slice(0, 700)}…` : content;
                return `${header}\n${truncated}`;
              })
              .join("\n\n");
          } else {
            retrievedContext = formatRetrievedContext(usedRows);
          }
        }
        const MAX_RETRIEVED_CONTEXT_CHARS = isAggregationQuery ? 20_000 : 12_000;
        if (retrievedContext.length > MAX_RETRIEVED_CONTEXT_CHARS) {
          retrievedContext =
            retrievedContext.slice(0, MAX_RETRIEVED_CONTEXT_CHARS) +
            "\n\n[Context truncated]";
        }
      } catch (err) {
        // Retrieval is best-effort; proceed without external context on failure
        console.warn("Retrieval failed (embeddings/turbopuffer)", err);
      }
    }

    await saveMessages({
      messages: [
        {
          chatId: id,
          id: message.id,
          role: "user",
          parts: message.parts,
          attachments: [],
          createdAt: new Date(),
        },
      ],
    });

    const streamId = generateUUID();
    await createStreamId({ streamId, chatId: id });

    let finalMergedUsage: AppUsage | undefined;

    const stream = createUIMessageStream({
      execute: async ({ writer: dataStream }) => {
        let citationInstructions: string | null = null;
        if (sources.length > 0) {
          const seen = new Set<string>();
          const uniqueSources = [];
          for (const s of sources) {
            const sourceType = typeof s.sourceType === "string" ? s.sourceType : "";
            const docId = typeof s.doc_id === "string" ? s.doc_id : "";
            const blobUrl = typeof s.blob_url === "string" ? s.blob_url : "";
            const sourceUrl = typeof (s as any).source_url === "string" ? (s as any).source_url : "";
            const slackUrl = typeof (s as any).url === "string" ? (s as any).url : "";
            const channelName =
              typeof (s as any).channel_name === "string" ? (s as any).channel_name : "";
            const preferredUrl =
              sourceType === "docs" && sourceUrl.toLowerCase().includes("sharepoint.com")
                ? sourceUrl
                : sourceType === "slack" && slackUrl
                  ? slackUrl
                  : blobUrl || sourceUrl;
            const filename = typeof s.filename === "string" ? s.filename : "";
            const category =
              typeof (s as any).doc_category === "string" ? (s as any).doc_category : "";
            const description =
              typeof (s as any).doc_description === "string"
                ? (s as any).doc_description
                : "";
            const projectId =
              typeof (s as any).project_id === "string" ? (s as any).project_id : "";
            const key =
              sourceType === "docs" && projectId && filename
                ? `${sourceType}:${projectId}:${filename}`
                : docId
                  ? `${sourceType}:${docId}`
                  : blobUrl
                    ? `${sourceType}:${blobUrl}`
                    : `${sourceType}:${filename}`;

            if (seen.has(key)) continue;
            seen.add(key);
            uniqueSources.push({
              sourceType,
              docId: docId || undefined,
              filename: filename || undefined,
              channelName: channelName || undefined,
              category: category || undefined,
              description: description || undefined,
              documentType:
                typeof (s as any).document_type === "string"
                  ? (s as any).document_type
                  : undefined,
              blobUrl: preferredUrl || undefined,
              content:
                typeof s.content === "string" ? s.content.slice(0, 200) : undefined,
            });
          }

          const sourceLines = uniqueSources
            .slice(0, 20)
            .map((s, idx) => {
              const label =
                (s.sourceType === "slack" && s.channelName ? `#${s.channelName}` : null) ??
                s.filename ??
                (typeof s.blobUrl === "string" && s.blobUrl.length > 0
                  ? s.blobUrl
                  : s.sourceType || "Source");
              const docIdSuffix =
                typeof s.docId === "string" && s.docId.length > 0
                  ? ` (doc_id=${s.docId})`
                  : "";
              const typeSuffix =
                typeof (s as any).documentType === "string"
                  ? ` (document_type=${String((s as any).documentType)})`
                  : "";
              return `[${idx + 1}] ${label}${docIdSuffix}${typeSuffix}`;
            })
            .join("\n");
          const maxCitationIndex = Math.min(uniqueSources.length, 20);
          citationInstructions = sourceLines.length
            ? `\n\nSources (for citations):\n${sourceLines}\n\nIf you use retrieved context, cite it inline using the exact marker format \`【N】\` where N is the source number above. Valid N values are 1 through ${maxCitationIndex}. Never use any other number. Only include citations you actually used; if you didn't use any sources, include no \`【N】\` markers. Do not add a separate "Citations" section.`
            : null;

          dataStream.write({
            type: "data-sources",
            data: uniqueSources,
          });
        }

        const synergySystemPrompt =
          "You are Synergy (FrontlineAgent).\n\nYou answer questions based primarily on the conversation (the user's messages and your prior replies). Retrieved context (Slack messages and uploaded docs) is OPTIONAL background and may be irrelevant; only use it when it clearly helps answer the current question.\n\nYou can delegate to specialist agents (tools):\n- runProjectAgent: project/entity state and diagnostics.\n- runFinanceAgent: deterministic finance analysis (uses financeQuery internally).\n- runCitationsAgent: validate claims against sources and add inline citations like 【N】.\n\nRules:\n- Use runFinanceAgent for any totals/sums/counts/aggregations. \n- If you need both a total and a breakdown (e.g. \"by month\"), ensure you ask the specialist for both or use the total provided by the specialist.\n- When presenting structured numeric results (breakdowns, comparisons, lists), prefer GitHub-flavored markdown tables.\n- If the user asks about a month by name (e.g. \"November\") but does not specify a year, assume the year is the current year.\n- If the user's message is a follow-up like \"break it down\" / \"by category\" / \"show me the list\" and omits time or entity, you MUST infer the missing time/entity from the immediately preceding conversation turns and include them explicitly when calling runFinanceAgent.\n- If entity ambiguity exists (Personal vs one or more businesses), ask a clarifying question before answering.\n- Prefer bank-statement deposits for income-like questions, excluding transfers.\n- If you used retrieved context, optionally call runCitationsAgent at the end to add citations.\n\nKeep clarifying questions short and actionable.";

        const baseMessages = convertToModelMessages(uiMessages);

        const lastUserMessage = uiMessages.slice().reverse().find((m) => m.role === "user");
        const lastUserTextParts = lastUserMessage
          ? lastUserMessage.parts.filter(
              (
                part
              ): part is Extract<
                (typeof lastUserMessage.parts)[number],
                { type: "text" }
              > => part.type === "text"
            )
          : [];
        const lastUserText = lastUserTextParts
          .map((part) => part.text)
          .join("\n")
          .slice(0, 4000);
        const isAggregationQuery = AGGREGATION_HINT_RE.test(lastUserText);

        // For aggregation/finance questions, don't inject retrieved/project context into the main prompt.
        // The frontline is required to call FinanceAgent tools instead of trusting potentially stale context.
        const messagesWithContext = (() => {
          if (!retrievedContext || isAggregationQuery) return baseMessages;

          const lastUserIndex = (() => {
            for (let i = baseMessages.length - 1; i >= 0; i -= 1) {
              const m = baseMessages[i] as { role?: unknown };
              if (m?.role === "user") return i;
            }
            return -1;
          })();
          if (lastUserIndex === -1) return baseMessages;

          const injected = {
            role: "user" as const,
            content: `Background retrieved context (may be irrelevant):\n\n${retrievedContext}${citationInstructions ?? ""}`,
          };
          return [
            ...baseMessages.slice(0, lastUserIndex),
            injected,
            ...baseMessages.slice(lastUserIndex),
          ];
        })();

        const basetenApiKey = process.env.BASETEN_API_KEY;
        const mustUseTextOnly =
          Boolean(basetenApiKey) ||
          hasNonImageFileParts(messagesWithContext as unknown[]);
        const textOnlyMessages = mustUseTextOnly
          ? coerceMessagesToTextOnly(messagesWithContext as unknown[])
          : messagesWithContext;

        // Frontline router: can short-circuit with a clarifying question before any tool calls.
        // Skip this for aggregation/finance questions so FinanceAgent can drive entity selection via DB tools.
        if (!isAggregationQuery) {
          try {
            const decision = await decideFrontlineRouting({
              _session: session,
              input: { question: lastUserText, retrieved_context: retrievedContext },
            });
            if (decision.questions_for_user.length > 0) {
              const msgId = generateUUID();
              dataStream.write({ type: "text-start", id: msgId });
              dataStream.write({
                type: "text-delta",
                id: msgId,
                delta: decision.questions_for_user.join(" "),
              });
              dataStream.write({ type: "text-end", id: msgId });
              return;
            }
          } catch {
            // Fall through if router fails.
          }
        }

        const result = streamText({
          model: myProvider.languageModel(selectedChatModel),
          system: synergySystemPrompt,
          messages: textOnlyMessages as any,
          stopWhen: stepCountIs(5),
          onStepFinish: async (step) => {
            const shouldDebugAgentToChat = process.env.NODE_ENV !== "production";
            const shouldDebugFinanceAgentToChat =
              shouldDebugAgentToChat && process.env.DEBUG_FINANCE_AGENT_CHAT === "1";
            const shouldDebugProjectAgentToChat =
              shouldDebugAgentToChat && process.env.DEBUG_PROJECT_AGENT_CHAT === "1";
            const shouldDebugCitationsAgentToChat =
              shouldDebugAgentToChat && process.env.DEBUG_CITATIONS_AGENT_CHAT === "1";

            const summarizeAgentOutputForChat = (output: unknown) => {
              if (typeof output !== "object" || output === null) return output;
              const o = output as Record<string, unknown>;

              const toolCallsRaw = Array.isArray(o.tool_calls) ? o.tool_calls : [];
              const tool_calls = toolCallsRaw
                .filter((tc) => typeof tc === "object" && tc !== null)
                .slice(0, 25)
                .map((tc) => {
                  const t = tc as Record<string, unknown>;
                  const toolName = typeof t.toolName === "string" ? t.toolName : "tool";
                  const input = t.input;
                  const out = t.output;

                  // Prevent dumping huge result sets into chat.
                  const outputSummary =
                    typeof out === "object" && out !== null
                      ? (() => {
                          const r = out as Record<string, unknown>;
                          if (Array.isArray(r.rows)) {
                            return {
                              ...r,
                              rowsCount: r.rows.length,
                              rows: r.rows.slice(0, 5),
                            };
                          }
                          return r;
                        })()
                      : out;

                  return {
                    toolName,
                    input,
                    output: outputSummary,
                  };
                });

              return {
                kind: o.kind,
                confidence: o.confidence,
                questions_for_user: o.questions_for_user,
                assumptions: o.assumptions,
                answer_draft: o.answer_draft,
                tool_calls,
              };
            };

            if (step.toolCalls.length > 0 || step.toolResults.length > 0) {
              console.log("[chat] step finish", {
                stepFinishReason: step.finishReason,
                toolCalls: step.toolCalls.map((c) => ({
                  toolName: c.toolName,
                  input: c.input,
                })),
                toolResults: step.toolResults.map((r) => ({
                  toolName: r.toolName,
                  output: r.output,
                  preliminary: r.preliminary ?? false,
                })),
              });
            }

            if (step.toolResults.length > 0) {
              const toolsToDebug = [
                shouldDebugFinanceAgentToChat ? "runFinanceAgent" : null,
                shouldDebugProjectAgentToChat ? "runProjectAgent" : null,
                shouldDebugCitationsAgentToChat ? "runCitationsAgent" : null,
              ].filter((t): t is string => typeof t === "string");

              for (const toolName of toolsToDebug) {
                const results = step.toolResults.filter((r) => r.toolName === toolName);
                for (const r of results) {
                  const msgId = generateUUID();
                  const summary = summarizeAgentOutputForChat(r.output);
                  const payload = JSON.stringify(summary, null, 2);
                  dataStream.write({ type: "text-start", id: msgId });
                  dataStream.write({
                    type: "text-delta",
                    id: msgId,
                    delta: `\n\n---\n\n**[debug] ${toolName} output**\n\n\`\`\`json\n${payload}\n\`\`\`\n`,
                  });
                  dataStream.write({ type: "text-end", id: msgId });
                }
              }
            }
          },
          experimental_activeTools:
            isAggregationQuery
              ? ["financeQuery", "runFinanceAgent", "runProjectAgent", "runCitationsAgent"]
              : [
                  "getWeather",
                  "createDocument",
                  "updateDocument",
                  "requestSuggestions",
                  "financeQuery",
                  "runFinanceAgent",
                  "runProjectAgent",
                  "runCitationsAgent",
                ],
          experimental_transform: smoothStream({ chunking: "word" }),
          tools: {
            getWeather,
            createDocument: createDocument({ session, dataStream }),
            updateDocument: updateDocument({ session, dataStream }),
            requestSuggestions: requestSuggestions({
              session,
              dataStream,
            }),
            financeQuery: financeQuery({ session, projectId: activeProjectId }),
            runFinanceAgent: tool({
              description:
                "Delegate to FinanceAgent for deterministic finance analysis. Returns structured JSON including questions_for_user when clarification is needed.",
              inputSchema: z.object({
                question: z.string().min(1).max(4000),
              }),
              execute: async ({ question }) => {
                return await runFinanceAgent({
                  session,
                  projectId: activeProjectId,
                  input: { question },
                });
              },
            }),
            runProjectAgent: tool({
              description:
                "Delegate to ProjectAgent for project/entity state and diagnostics. Returns structured JSON.",
              inputSchema: z.object({
                question: z.string().min(1).max(4000),
              }),
              execute: async ({ question }) => {
                return await runProjectAgent({
                  session,
                  input: { question, projectId: activeProjectId },
                });
              },
            }),
            runCitationsAgent: tool({
              description:
                "Delegate to CitationsAgent to validate claims against sources and add inline citations like 【N】. Returns structured JSON.",
              inputSchema: z.object({
                question: z.string().min(1).max(4000),
                draft_answer: z.string().min(1).max(20000),
              }),
              execute: async ({ question, draft_answer }) => {
                const sourceItems = sources
                  .slice(0, 20)
                  .map((s, idx) => ({
                    index: idx + 1,
                    label:
                      (typeof (s as any).filename === "string" && (s as any).filename.length > 0
                        ? (s as any).filename
                        : typeof (s as any).channel_name === "string" && (s as any).channel_name.length > 0
                          ? `#${String((s as any).channel_name)}`
                          : "Source") as string,
                    content:
                      typeof (s as any).content === "string"
                        ? String((s as any).content).slice(0, 5000)
                        : undefined,
                  }));
                return await runCitationsAgent({
                  _session: session,
                  input: { question, draft_answer, sources: sourceItems },
                });
              },
            }),
          },
          experimental_telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: "stream-text",
          },
          onFinish: async ({ usage }) => {
            try {
              const providers = await getTokenlensCatalog();
              const modelId =
                myProvider.languageModel(selectedChatModel).modelId;
              if (!modelId) {
                finalMergedUsage = usage;
                dataStream.write({
                  type: "data-usage",
                  data: finalMergedUsage,
                });
                return;
              }

              if (!providers) {
                finalMergedUsage = usage;
                dataStream.write({
                  type: "data-usage",
                  data: finalMergedUsage,
                });
                return;
              }

              const summary = getUsage({ modelId, usage, providers });
              finalMergedUsage = { ...usage, ...summary, modelId } as AppUsage;
              dataStream.write({ type: "data-usage", data: finalMergedUsage });
            } catch (err) {
              console.warn("TokenLens enrichment failed", err);
              finalMergedUsage = usage;
              dataStream.write({ type: "data-usage", data: finalMergedUsage });
            }
          },
        });

        result.consumeStream();

        dataStream.merge(
          result.toUIMessageStream({
            sendReasoning: true,
          })
        );
      },
      generateId: generateUUID,
      onFinish: async ({ messages }) => {
        await saveMessages({
          messages: messages.map((currentMessage) => ({
            id: currentMessage.id,
            role: currentMessage.role,
            parts: currentMessage.parts,
            createdAt: new Date(),
            attachments: [],
            chatId: id,
          })),
        });

        if (finalMergedUsage) {
          try {
            await updateChatLastContextById({
              chatId: id,
              context: finalMergedUsage,
            });
          } catch (err) {
            console.warn("Unable to persist last usage for chat", id, err);
          }
        }
      },
      onError: () => {
        return "Oops, an error occurred!";
      },
    });

    // const streamContext = getStreamContext();

    // if (streamContext) {
    //   return new Response(
    //     await streamContext.resumableStream(streamId, () =>
    //       stream.pipeThrough(new JsonToSseTransformStream())
    //     )
    //   );
    // }

    return new Response(stream.pipeThrough(new JsonToSseTransformStream()));
  } catch (error) {
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }

    // Check for Vercel AI Gateway credit card error
    if (
      error instanceof Error &&
      error.message?.includes(
        "AI Gateway requires a valid credit card on file to service requests"
      )
    ) {
      return new ChatSDKError("bad_request:activate_gateway").toResponse();
    }

    console.error("Unhandled error in chat API:", error, { vercelId });
    return new ChatSDKError("offline:chat").toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatSDKError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
