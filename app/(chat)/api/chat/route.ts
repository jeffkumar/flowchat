import { geolocation } from "@vercel/functions";
import {
  convertToModelMessages,
  createUIMessageStream,
  JsonToSseTransformStream,
  smoothStream,
  stepCountIs,
  streamText,
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
import { auth, type UserType } from "@/app/(auth)/auth";
import type { VisibilityType } from "@/components/visibility-selector";
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
    }: {
      id: string;
      message: ChatMessage;
      selectedChatModel: ChatModel["id"];
      selectedVisibilityType: VisibilityType;
      projectId?: string;
      sourceTypes?: Array<"slack" | "docs">;
      ignoredDocIds?: string[];
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
        });

        const perNamespaceTopK = 24;

        const rowsByNamespace = await Promise.all(
          namespaces.map(async (ns) => {
            const filters =
              ignoredDocIds && ignoredDocIds.length > 0
                ? ["Not", ["doc_id", "In", ignoredDocIds]]
                : undefined;

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

        const filteredRows = fusedRows.slice(0, 24);
        const usedRows = filteredRows.slice(0, 8);
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
        retrievedContext = formatRetrievedContext(usedRows);
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
