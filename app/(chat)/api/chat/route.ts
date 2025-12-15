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
  saveChat,
  saveMessages,
  updateChatLastContextById,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { ChatSDKError } from "@/lib/errors";
import type { ChatMessage } from "@/lib/types";
import type { AppUsage } from "@/lib/usage";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";
import { formatRetrievedContext, queryTurbopuffer } from "@/lib/rag/turbopuffer";

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
    }: {
      id: string;
      message: ChatMessage;
      selectedChatModel: ChatModel["id"];
      selectedVisibilityType: VisibilityType;
      projectId?: string;
      sourceTypes?: Array<"slack" | "docs">;
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

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatSDKError("forbidden:chat").toResponse();
      }
      // Only fetch messages if chat already exists
      messagesFromDb = await getMessagesByChatId({ id });
    } else {
      const title = await generateTitleFromUserMessage({
        message,
      });

      await saveChat({
        id,
        userId: session.user.id,
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
      (part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
        part.type === "text"
    );
    const userText = userTextParts
      .map((part) => part.text)
      .join("\n")
      .slice(0, 4000);

    let retrievedContext = "";
    if (userText) {
      try {
        const requestedSourceTypes =
          Array.isArray(sourceTypes) && sourceTypes.length > 0
            ? sourceTypes
            : ["slack", "docs"];
        const namespaces =
          requestedSourceTypes.length === 1 && requestedSourceTypes[0] === "docs"
            ? ["_synergy_docs"]
            : requestedSourceTypes.length === 1 && requestedSourceTypes[0] === "slack"
              ? ["_synergy_slack"]
              : ["_synergy_slack", "_synergy_docs"];

        const perNamespaceTopK = 24;

        const rowsByNamespace = await Promise.all(
          namespaces.map(async (ns) => {
            const nsRows = await queryTurbopuffer({
              query: userText,
              topK: perNamespaceTopK,
              namespace: ns,
            });

            const inferredSourceType =
              ns === "_synergy_docs" ? "docs" : ns === "_synergy_slack" ? "slack" : "";

            return nsRows.map((r) => ({
              ...r,
              sourceType:
                typeof (r as any).sourceType === "string"
                  ? (r as any).sourceType
                  : inferredSourceType,
            }));
          })
        );

        const fusedRows = rowsByNamespace
          .flat()
          .sort((a, b) => {
            const da =
              typeof a.$dist === "number" ? a.$dist : Number.POSITIVE_INFINITY;
            const db =
              typeof b.$dist === "number" ? b.$dist : Number.POSITIVE_INFINITY;
            return da - db;
          });

        const filteredRows = fusedRows.slice(0, 24);
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
                typeof r.$dist === "number" ? Number(r.$dist.toFixed(3)) : r.$dist,
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
        retrievedContext = formatRetrievedContext(filteredRows.slice(0, 8));
        const MAX_RETRIEVED_CONTEXT_CHARS = 12000;
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
