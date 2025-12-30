"use client";
import type { UseChatHelpers } from "@ai-sdk/react";
import equal from "fast-deep-equal";
import { memo, useState } from "react";
import type { Vote } from "@/lib/db/schema";
import type { ChatMessage, RetrievedSource } from "@/lib/types";
import { cn, sanitizeText } from "@/lib/utils";
import { useDataStream } from "./data-stream-provider";
import { DocumentToolResult } from "./document";
import { DocumentPreview } from "./document-preview";
import { MessageContent } from "./elements/message";
import { Response } from "./elements/response";
import { Source } from "./elements/source";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "./elements/tool";
import { SparklesIcon } from "./icons";
import { MessageActions } from "./message-actions";
import { MessageEditor } from "./message-editor";
import { MessageReasoning } from "./message-reasoning";
import { PreviewAttachment } from "./preview-attachment";
import { Weather } from "./weather";

const PurePreviewMessage = ({
  chatId,
  message,
  vote,
  isLoading,
  setMessages,
  regenerate,
  isReadonly,
  requiresScrollPadding: _requiresScrollPadding,
  showCitations,
}: {
  chatId: string;
  message: ChatMessage;
  vote: Vote | undefined;
  isLoading: boolean;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  requiresScrollPadding: boolean;
  showCitations: boolean;
}) => {
  const [mode, setMode] = useState<"view" | "edit">("view");

  const existingSources = (
    message.annotations?.find((a: any) => a?.type === "sources") as any
  )?.data as RetrievedSource[] | undefined;

  const sources = existingSources;
  const uniqueSources = (() => {
    if (!sources || sources.length === 0) return [];
    const seen = new Set<string>();
    const out: RetrievedSource[] = [];
    for (const s of sources) {
      const sourceType = typeof s.sourceType === "string" ? s.sourceType : "";
      const docId = typeof s.docId === "string" ? s.docId : "";
      const blobUrl = typeof s.blobUrl === "string" ? s.blobUrl : "";
      const filename = typeof s.filename === "string" ? s.filename : "";
      const key = docId
        ? `${sourceType}:${docId}`
        : blobUrl
          ? `${sourceType}:${blobUrl}`
          : `${sourceType}:${filename}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out;
  })();

  const usedCitationSources = (() => {
    if (!showCitations || uniqueSources.length === 0) return [];
    if (message.role !== "assistant") return [];

    const indices = new Set<number>();
    for (const part of message.parts) {
      if (part.type !== "text") continue;
      const text = typeof part.text === "string" ? part.text : "";
      // Use a citation marker that won't be treated as Markdown footnotes.
      // Example: 【1】 refers to the 1st source in the provided sources list.
      const matches = text.matchAll(/【(\d+)】/g);
      for (const match of matches) {
        const raw = match[1];
        if (!raw) continue;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 1) continue;
        indices.add(n);
      }
    }

    if (indices.size === 0) return [];

    const sorted = Array.from(indices).sort((a, b) => a - b);
    const used: RetrievedSource[] = [];
    for (const n of sorted) {
      const source = uniqueSources[n - 1];
      if (source) used.push(source);
    }
    return used;
  })();

  const shouldEnumerateCitations = usedCitationSources.length > 1;

  const sanitizeCitationMarkers = (text: string): string => {
    if (message.role !== "assistant") return text;
    if (!showCitations) {
      return text.replace(/【(\d+)】/g, "");
    }
    // During streaming, sources may not be attached yet. Strip markers to avoid
    // showing confusing citation indices that can't be resolved.
    if (uniqueSources.length === 0) {
      return text.replace(/【(\d+)】/g, "");
    }

    return text.replace(/【(\d+)】/g, (full, raw: string) => {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1) return "";
      return n <= uniqueSources.length ? full : "";
    });
  };

  // Keep 1:1 indexing with `uniqueSources` so marker 【N】 always maps to source N.
  const citationHrefsByIndex = uniqueSources.map((s) =>
    typeof s.blobUrl === "string" ? s.blobUrl : ""
  );
  const citationHrefs = citationHrefsByIndex.filter((href) => href.length > 0);
  const citationHrefsKey = citationHrefsByIndex.join("|");

  const getSourceLabel = (source: RetrievedSource | undefined): string => {
    if (source?.sourceType === "slack") {
      return source.channelName ? `#${source.channelName}` : "Slack";
    }

    const name = source?.filename ?? "";
    const lastDot = name.lastIndexOf(".");
    const ext =
      lastDot >= 0 && lastDot < name.length - 1 ? name.slice(lastDot + 1) : "";
    const upper = ext.trim().toUpperCase();
    if (upper === "PDF" || upper === "DOC" || upper === "DOCX") return upper;

    return "Source";
  };

  const linkifyCitationMarkers = (text: string): string => {
    if (!showCitations) return text;
    if (message.role !== "assistant") return text;
    if (uniqueSources.length === 0) return text;

    return text.replace(/【(\d+)】/g, (full, raw: string) => {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1 || n > uniqueSources.length) return "";
      const href = citationHrefsByIndex.at(n - 1);
      if (!href) return full;
      const labelPart = getSourceLabel(uniqueSources.at(n - 1));
      const label = shouldEnumerateCitations ? `${n} ${labelPart}` : labelPart;
      return `[${label}](${href})`;
    });
  };

  const attachmentsFromMessage = message.parts.filter(
    (part) => part.type === "file"
  );

  useDataStream();

  return (
    <div
      className="group/message fade-in w-full animate-in duration-200"
      data-role={message.role}
      data-testid={`message-${message.role}`}
    >
      <div
        className={cn("flex w-full items-start gap-2 md:gap-3", {
          "justify-end": message.role === "user" && mode !== "edit",
          "justify-start": message.role === "assistant",
        })}
      >
        {message.role === "assistant" && (
          <div className="-mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-border">
            <SparklesIcon size={14} />
          </div>
        )}

        <div
          className={cn("flex flex-col", {
            "gap-2 md:gap-4": message.parts?.some(
              (p) => p.type === "text" && p.text?.trim()
            ),
            "w-full":
              (message.role === "assistant" &&
                message.parts?.some(
                  (p) => p.type === "text" && p.text?.trim()
                )) ||
              mode === "edit",
            "max-w-[calc(100%-2.5rem)] sm:max-w-[min(fit-content,80%)]":
              message.role === "user" && mode !== "edit",
          })}
        >
          {attachmentsFromMessage.length > 0 && (
            <div
              className="flex flex-row justify-end gap-2"
              data-testid={"message-attachments"}
            >
              {attachmentsFromMessage.map((attachment) => (
                <PreviewAttachment
                  attachment={{
                    name: attachment.filename ?? "file",
                    contentType: attachment.mediaType,
                    url: attachment.url,
                  }}
                  key={attachment.url}
                />
              ))}
            </div>
          )}

          {message.parts?.map((part, index) => {
            const { type } = part;
            const key = `message-${message.id}-part-${index}`;

            if (type === "reasoning" && part.text?.trim().length > 0) {
              return (
                <MessageReasoning
                  isLoading={isLoading}
                  key={key}
                  reasoning={part.text}
                />
              );
            }

            if (type === "text") {
              if (mode === "view") {
                const safe = sanitizeCitationMarkers(sanitizeText(part.text));
                const text = linkifyCitationMarkers(safe);
                return (
                  <div key={key}>
                    <MessageContent
                      className={cn({
                        "w-fit break-words rounded-2xl bg-brand/15 px-3 py-2 text-right text-foreground dark:bg-primary dark:text-primary-foreground":
                          message.role === "user",
                        "bg-transparent px-0 py-0 text-left":
                          message.role === "assistant",
                      })}
                      data-testid="message-content"
                    >
                      <Response
                        citationHrefs={showCitations ? citationHrefs : undefined}
                        citationHrefsKey={showCitations ? citationHrefsKey : undefined}
                      >
                        {text}
                      </Response>
                    </MessageContent>
                  </div>
                );
              }

              if (mode === "edit") {
                return (
                  <div
                    className="flex w-full flex-row items-start gap-3"
                    key={key}
                  >
                    <div className="size-8" />
                    <div className="min-w-0 flex-1">
                      <MessageEditor
                        key={message.id}
                        message={message}
                        regenerate={regenerate}
                        setMessages={setMessages}
                        setMode={setMode}
                      />
                    </div>
                  </div>
                );
              }
            }

            if (type === "tool-getWeather") {
              const { toolCallId, state } = part;

              return (
                <Tool defaultOpen={true} key={toolCallId}>
                  <ToolHeader state={state} type="tool-getWeather" />
                  <ToolContent>
                    {state === "input-available" && (
                      <ToolInput input={part.input} />
                    )}
                    {state === "output-available" && (
                      <ToolOutput
                        errorText={undefined}
                        output={<Weather weatherAtLocation={part.output} />}
                      />
                    )}
                  </ToolContent>
                </Tool>
              );
            }

            if (type === "tool-createDocument") {
              const { toolCallId } = part;

              if (part.output && "error" in part.output) {
                return (
                  <div
                    className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-500 dark:bg-red-950/50"
                    key={toolCallId}
                  >
                    Error creating document: {String(part.output.error)}
                  </div>
                );
              }

              return (
                <DocumentPreview
                  isReadonly={isReadonly}
                  key={toolCallId}
                  result={part.output}
                />
              );
            }

            if (type === "tool-updateDocument") {
              const { toolCallId } = part;

              if (part.output && "error" in part.output) {
                return (
                  <div
                    className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-500 dark:bg-red-950/50"
                    key={toolCallId}
                  >
                    Error updating document: {String(part.output.error)}
                  </div>
                );
              }

              return (
                <div className="relative" key={toolCallId}>
                  <DocumentPreview
                    args={{ ...part.output, isUpdate: true }}
                    isReadonly={isReadonly}
                    result={part.output}
                  />
                </div>
              );
            }

            if (type === "tool-requestSuggestions") {
              const { toolCallId, state } = part;

              return (
                <Tool defaultOpen={true} key={toolCallId}>
                  <ToolHeader state={state} type="tool-requestSuggestions" />
                  <ToolContent>
                    {state === "input-available" && (
                      <ToolInput input={part.input} />
                    )}
                    {state === "output-available" && (
                      <ToolOutput
                        errorText={undefined}
                        output={
                          "error" in part.output ? (
                            <div className="rounded border p-2 text-red-500">
                              Error: {String(part.output.error)}
                            </div>
                          ) : (
                            <DocumentToolResult
                              isReadonly={isReadonly}
                              result={part.output}
                              type="request-suggestions"
                            />
                          )
                        }
                      />
                    )}
                  </ToolContent>
                </Tool>
              );
            }

            return null;
          })}

          {usedCitationSources.length > 0 && (
            <div className="mt-4 flex flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground">
                Citations
              </div>
              <div className="flex flex-wrap gap-2">
                {usedCitationSources.map((source, i) => {
                  const indexInUnique = uniqueSources.indexOf(source);
                  const citationNumber = indexInUnique >= 0 ? indexInUnique + 1 : i + 1;
                  const baseTitle =
                    source.sourceType === "slack"
                      ? source.channelName
                        ? `#${source.channelName}`
                        : "Slack"
                      : source.filename ?? "Source";
                  const href = source.blobUrl;
                  const isSharePoint =
                    source.sourceType === "docs" &&
                    typeof href === "string" &&
                    href.toLowerCase().includes("sharepoint.com");
                  const title = baseTitle;

                  if (typeof href === "string" && href.length > 0) {
                    return (
                      <Source
                        href={href}
                        aria-label={
                          shouldEnumerateCitations
                            ? `Open source ${citationNumber}: ${
                                isSharePoint ? `SharePoint: ${title}` : title
                              }`
                            : `Open source: ${isSharePoint ? `SharePoint: ${title}` : title}`
                        }
                        className="rounded-full border bg-muted/50 px-3 py-1 text-xs font-medium hover:bg-muted"
                        key={i}
                        title={title}
                      >
                        {shouldEnumerateCitations ? `${citationNumber}. ${title}` : title}
                      </Source>
                    );
                  }

                  return (
                    <div
                      className="rounded-full border bg-muted/50 px-3 py-1 text-xs font-medium"
                      key={i}
                      title={title}
                    >
                      <span className="block max-w-[240px] truncate">
                        {shouldEnumerateCitations ? `${citationNumber}. ${title}` : title}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!isReadonly && (
            <MessageActions
              chatId={chatId}
              isLoading={isLoading}
              key={`action-${message.id}`}
              message={message}
              setMode={setMode}
              vote={vote}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export const PreviewMessage = memo(
  PurePreviewMessage,
  (prevProps, nextProps) => {
    if (prevProps.isLoading !== nextProps.isLoading) {
      return false;
    }
    if (prevProps.message.id !== nextProps.message.id) {
      return false;
    }
    if (prevProps.requiresScrollPadding !== nextProps.requiresScrollPadding) {
      return false;
    }
    if (!equal(prevProps.message.parts, nextProps.message.parts)) {
      return false;
    }
    if (!equal(prevProps.vote, nextProps.vote)) {
      return false;
    }
    if (prevProps.showCitations !== nextProps.showCitations) {
      return false;
    }
    return false;
  }
);

export const ThinkingMessage = ({
  agentStatus,
  showIcon = true,
}: {
  agentStatus?: { agent: string; message: string };
  showIcon?: boolean;
}) => {
  const displayText =
    agentStatus && agentStatus.message.trim().length > 0
      ? agentStatus.message
      : "Thinking";

  return (
    <div
      className="group/message fade-in w-full animate-in duration-300"
      data-role="assistant"
      data-testid="message-assistant-loading"
    >
      <div className="flex items-start justify-start gap-3">
        {showIcon && (
          <div className="-mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-border">
            <div className="animate-pulse">
              <SparklesIcon size={14} />
            </div>
          </div>
        )}

        <div className="flex w-full flex-col gap-2 md:gap-4">
          <div className="flex items-center gap-1 p-0 text-muted-foreground text-sm">
            <span className="animate-pulse">{displayText}</span>
            {!agentStatus && (
              <span className="inline-flex">
                <span className="animate-bounce [animation-delay:0ms]">.</span>
                <span className="animate-bounce [animation-delay:150ms]">.</span>
                <span className="animate-bounce [animation-delay:300ms]">.</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
