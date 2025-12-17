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
import { createDocument } from "@/lib/ai/tools/create-document";
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
  /\b(last|past|yesterday|today|since|between|from|in the last|\d+\s*(day|week|month|year)s?)\b/i;

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

async function inferRetrievalRangePreset({
  userText,
}: {
  userText: string;
}): Promise<RetrievalRangePreset> {
  let selected: RetrievalRangePreset = "all";

  await generateText({
    model: myProvider.languageModel("chat-model"),
    system:
      "Choose the best retrieval time range preset for the user's request. " +
      "If the user does not specify a time range, choose 'all'. " +
      "If the user asks for 'last day', 'yesterday', or 'last 24 hours', choose '1d'. " +
      "If the user asks for a range that doesn't map exactly, choose the closest *broader* preset (e.g. 3 days -> 7d). " +
      "You MUST call the provided tool and nothing else.",
    messages: [{ role: "user", content: userText }],
    tools: {
      selectTimeRange: tool({
        description: "Select the retrieval time range preset.",
        inputSchema: z.object({
          preset: z.enum(["all", "1d", "7d", "30d", "90d"]),
        }),
        execute: async ({ preset }) => {
          selected = preset;
          return { preset };
        },
      }),
    },
    toolChoice: { type: "tool", toolName: "selectTimeRange" },
    temperature: 0,
    maxOutputTokens: 50,
    stopWhen: stepCountIs(1),
  });

  return selected;
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

async function inferRelativeDay({
  userText,
}: {
  userText: string;
}): Promise<RelativeDay | null> {
  let selected: RelativeDay | null = null;
  await generateText({
    model: myProvider.languageModel("chat-model"),
    system:
      "Determine whether the user is asking for a specific relative day. " +
      "If they mean a specific day window, choose one of: today, yesterday, dayBeforeYesterday. " +
      "If they are NOT asking for a specific single-day window, choose 'none'. " +
      "You MUST call the provided tool and nothing else.",
    messages: [{ role: "user", content: userText }],
    tools: {
      selectRelativeDay: tool({
        description: "Select a relative day window (or none).",
        inputSchema: z.object({
          which: z.enum(["none", "today", "yesterday", "dayBeforeYesterday"]),
        }),
        execute: async ({ which }) => {
          selected = which === "none" ? null : which;
          return { which };
        },
      }),
    },
    toolChoice: { type: "tool", toolName: "selectRelativeDay" },
    temperature: 0,
    maxOutputTokens: 50,
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

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
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
    if (userText) {
      try {
        const nowMs = Date.now();
        const effectiveTimeZone =
          typeof retrievalTimeZone === "string" && retrievalTimeZone.length > 0
            ? retrievalTimeZone
            : "UTC";

        const requestedPreset = retrievalRangePreset;

        const relativeDay =
          /day before yesterday/i.test(userText) ||
          /\byesterday\b/i.test(userText) ||
          /\btoday\b/i.test(userText)
            ? await inferRelativeDay({ userText })
            : null;

        // Preset inference is useful for broad ranges like "last week", but it should NOT override
        // explicit single-day windows (today/yesterday/day before yesterday).
        const effectivePreset: RetrievalRangePreset =
          relativeDay
            ? "all"
            : requestedPreset && requestedPreset !== "all"
              ? requestedPreset
              : TIME_RANGE_HINT_RE.test(userText)
                ? await inferRetrievalRangePreset({ userText })
                : requestedPreset ?? "all";

        const requestedSourceTypes = (
          Array.isArray(sourceTypes) ? sourceTypes : undefined
        ) as SourceType[] | undefined;
        const namespaces = namespacesForSourceTypes(
          requestedSourceTypes,
          activeProjectId,
          isDefaultProject
        );

        console.log("Chat Retrieval Debug:", {
          activeProjectId,
          isDefaultProject,
          namespaces,
          requestedSourceTypes,
          ignoredDocIds,
          retrievalRangePreset: effectivePreset,
          retrievalRangePresetRequested: requestedPreset,
          retrievalTimeZone: effectiveTimeZone,
          retrievalRelativeDay: relativeDay,
        });

        const perNamespaceTopK = 24;
        const presetStartMs = startMsForPreset(effectivePreset, nowMs);
        const window =
          relativeDay && effectivePreset === "all"
            ? windowForRelativeDay({
                nowMs,
                timeZone: effectiveTimeZone,
                which: relativeDay,
              })
            : null;
        const rangeStartMs = window ? window.startMs : presetStartMs;
        const rangeEndMs = window ? window.endMs : nowMs;

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
          console.log("Chat Retrieval Relative Day Window:", {
            retrievalRelativeDay: relativeDay,
            retrievalTimeZone: effectiveTimeZone,
            startLocal,
            endLocal,
            startMs: window.startMs,
            endMs: window.endMs,
          });
        }

        const rowsByNamespace = await Promise.all(
          namespaces.map(async (ns) => {
            const filterParts: unknown[] = [];

            if (ignoredDocIds && ignoredDocIds.length > 0) {
              filterParts.push(["Not", ["doc_id", "In", ignoredDocIds]]);
            }

            if (rangeStartMs !== null) {
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
              query: userText,
              topK: perNamespaceTopK,
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
          })
        );

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

        console.log("Chat Retrieval Time Filter:", {
          retrievalRangePreset: effectivePreset,
          retrievalRangePresetRequested: requestedPreset,
          rangeStartMs,
          rangeEndMs,
          nowMs,
          fusedRowsCount: fusedRows.length,
          timeFilteredRowsCount: timeFilteredRows.length,
        });

        const filteredRows = timeFilteredRows.slice(0, 24);
        let usedRows = filteredRows.slice(0, 8);

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
            return oneLine.length > 50 ? `${oneLine.slice(0, 50)}…` : oneLine;
          };
          const byNamespaceCounts = rowsByNamespace.map((nsRows, i) => ({
            namespace: namespaces[i],
            rowsCount: nsRows.length,
          }));
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
              preview: truncatePreview(r.content),
            })),
          });
        } catch (_e) {
          // Ignore logging failures
        }
        if (!retrievedContext) {
          retrievedContext = formatRetrievedContext(usedRows);
        }
        const MAX_RETRIEVED_CONTEXT_CHARS = 12_000;
        if (retrievedContext.length > MAX_RETRIEVED_CONTEXT_CHARS) {
          retrievedContext =
            retrievedContext.slice(0, MAX_RETRIEVED_CONTEXT_CHARS) +
            "\n\n[Context truncated]";
        }
      } catch (err) {
        // Retrieval is best-effort; proceed without external context on failure
        console.warn("Turbopuffer retrieval failed", err);
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
      execute: ({ writer: dataStream }) => {
        if (sources.length > 0) {
          const seen = new Set<string>();
          const uniqueSources = [];
          for (const s of sources) {
            const sourceType = typeof s.sourceType === "string" ? s.sourceType : "";
            const docId = typeof s.doc_id === "string" ? s.doc_id : "";
            const blobUrl = typeof s.blob_url === "string" ? s.blob_url : "";
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
              category: category || undefined,
              description: description || undefined,
              blobUrl: blobUrl || undefined,
              content:
                typeof s.content === "string" ? s.content.slice(0, 200) : undefined,
            });
          }

          dataStream.write({
            type: "data-sources",
            data: uniqueSources,
          });
        }

        const synergySystemPrompt =
          "You are Synergy, a helpful assistant answering questions based on retrieved context (Slack messages and uploaded docs). Use the provided context when it is relevant. If the context does not contain the answer, say so briefly and answer from general knowledge when appropriate. When talking about people, projects, or events, only use names and details that explicitly appear in the retrieved context or the conversation so far; do not invent or guess new names.";

        const baseMessages = convertToModelMessages(uiMessages);
        const messagesWithContext = retrievedContext
          ? [
              {
                role: "system" as const,
                content: `Here is retrieved context:\n\n${retrievedContext}`,
              },
              ...baseMessages,
            ]
          : baseMessages;

        const result = streamText({
          model: myProvider.languageModel(selectedChatModel),
          system: synergySystemPrompt,
          messages: messagesWithContext,
          stopWhen: stepCountIs(5),
          experimental_activeTools:
            selectedChatModel === "chat-model-reasoning"
              ? []
              : [
                  "getWeather",
                  "createDocument",
                  "updateDocument",
                  "requestSuggestions",
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
