"use client";
import type { UseChatHelpers } from "@ai-sdk/react";
import equal from "fast-deep-equal";
import { memo, useState, useEffect } from "react";
import type { Vote } from "@/lib/db/schema";
import type {
  ChatMessage,
  ChartDocumentAnnotation,
  EntityOption,
  EntitySelectorAnnotation,
  TimeRangeOption,
  TimeRangeSelectorAnnotation,
  RetrievedSource,
} from "@/lib/types";
import { cn, fetcher, sanitizeText } from "@/lib/utils";
import { getRandomThinkingMessage } from "@/lib/ai/messages";
import { useArtifact } from "@/hooks/use-artifact";
import { useDataStream } from "./data-stream-provider";
import { DocumentToolResult } from "./document";
import { DocumentPreview } from "./document-preview";
import type { Document } from "@/lib/db/schema";
import useSWR from "swr";
import { ChartViewer, safeParseChartPayload } from "@/components/chart-viewer";
import { EntitySelector } from "@/components/entity-selector";
import { TimeRangeSelector } from "@/components/time-range-selector";
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
import { Maximize2 } from "lucide-react";

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
  selectedEntities = [],
  onEntitySelection = () => {},
  selectedTimeRange = null,
  onTimeRangeSelection = () => {},
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
  selectedEntities?: EntityOption[];
  onEntitySelection?: (args: { entities: EntityOption[]; questionId: string }) => void;
  selectedTimeRange?: TimeRangeOption | null;
  onTimeRangeSelection?: (args: { timeRange: TimeRangeOption; questionId: string }) => void;
}) => {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const { setArtifact } = useArtifact();

  const existingSources = (
    message.annotations?.find((a: any) => a?.type === "sources") as any
  )?.data as RetrievedSource[] | undefined;

  const chartAnnotation = message.annotations?.find(
    (a): a is ChartDocumentAnnotation => a?.type === "chart-document"
  );
  const [isChartCollapsed, setIsChartCollapsed] = useState(false);

  const entitySelectorAnnotation = message.annotations?.find(
    (a): a is EntitySelectorAnnotation => a?.type === "entity-selector"
  );
  const [isEntitySelectorCollapsed, setIsEntitySelectorCollapsed] = useState(false);

  const timeRangeSelectorAnnotation = message.annotations?.find(
    (a): a is TimeRangeSelectorAnnotation => a?.type === "time-range-selector"
  );
  const [isTimeRangeSelectorCollapsed, setIsTimeRangeSelectorCollapsed] = useState(false);

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

  const citationSources =
    showCitations && message.role === "assistant" ? uniqueSources : [];
  const shouldEnumerateCitations = citationSources.length > 1;

  const attachmentsFromMessage = message.parts.filter(
    (part) => part.type === "file"
  );

  useDataStream();

  const chartDocId = chartAnnotation?.data.documentId;
  const { data: chartDocs } = useSWR<Document[]>(
    chartDocId ? `/api/document?id=${chartDocId}` : null,
    fetcher,
    { shouldRetryOnError: false }
  );
  const chartDoc = chartDocs?.at(-1);
  const chartPayload = safeParseChartPayload(chartDoc?.content ?? "");

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
          {message.role === "assistant" && chartAnnotation && chartDocId ? (
            <div className="mb-3 w-full">
              <div className="rounded-xl border bg-background">
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {chartAnnotation.data.title}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="rounded-md border bg-background px-2 py-1 text-xs"
                      onClick={() => setIsChartCollapsed((v) => !v)}
                      type="button"
                    >
                      {isChartCollapsed ? "Expand" : "Collapse"}
                    </button>
                    <button
                      className="rounded-md border bg-background p-1.5"
                      disabled={isReadonly}
                      onClick={(event) => {
                        if (isReadonly) return;
                        const rect = event.currentTarget.getBoundingClientRect();
                        setArtifact((current) => ({
                          ...current,
                          documentId: chartDocId,
                          kind: "chart",
                          title: chartAnnotation.data.title,
                          isVisible: true,
                          status: "idle",
                          boundingBox: {
                            top: rect.top,
                            left: rect.left,
                            width: rect.width,
                            height: rect.height,
                          },
                        }));
                      }}
                      type="button"
                      title="Open in full screen"
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {!isChartCollapsed ? (
                  chartPayload ? (
                    <ChartViewer payload={chartPayload} />
                  ) : (
                    <div className="px-3 pb-3 text-sm text-muted-foreground">
                      Loading chart…
                    </div>
                  )
                ) : null}
              </div>
            </div>
          ) : null}

          {message.role === "assistant" && timeRangeSelectorAnnotation && !selectedTimeRange ? (
            <div className="mb-3 w-full">
              <div className="rounded-xl border bg-background">
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">Select time period</div>
                    <div className="text-xs text-muted-foreground">
                      Choose a time range for your finance query
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="rounded-md border bg-background px-2 py-1 text-xs"
                      onClick={() => setIsTimeRangeSelectorCollapsed((v) => !v)}
                      type="button"
                    >
                      {isTimeRangeSelectorCollapsed ? "Expand" : "Collapse"}
                    </button>
                  </div>
                </div>

                {!isTimeRangeSelectorCollapsed ? (
                  <div className="px-3 pb-3">
                    <TimeRangeSelector
                      availableTimeRanges={timeRangeSelectorAnnotation.data.availableTimeRanges}
                      defaultTimeRange={timeRangeSelectorAnnotation.data.defaultTimeRange}
                      onSelectionChange={(timeRange) => {
                        onTimeRangeSelection({
                          timeRange,
                          questionId: timeRangeSelectorAnnotation.data.questionId,
                        });
                      }}
                      questionId={timeRangeSelectorAnnotation.data.questionId}
                      selectedTimeRange={selectedTimeRange}
                      className="rounded-lg border p-4"
                    />
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {message.role === "assistant" && entitySelectorAnnotation && (!selectedEntities || selectedEntities.length === 0) ? (
            <div className="mb-3 w-full">
              <div className="rounded-xl border bg-background">
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">Select accounts</div>
                    <div className="text-xs text-muted-foreground">
                      Choose which accounts to use for the finance question
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="rounded-md border bg-background px-2 py-1 text-xs"
                      onClick={() => setIsEntitySelectorCollapsed((v) => !v)}
                      type="button"
                    >
                      {isEntitySelectorCollapsed ? "Expand" : "Collapse"}
                    </button>
                  </div>
                </div>

                {!isEntitySelectorCollapsed ? (
                  <div className="px-3 pb-3">
                    <EntitySelector
                      availableEntities={entitySelectorAnnotation.data.availableEntities}
                      onSelectionChange={(entities) => {
                        onEntitySelection({
                          entities,
                          questionId: entitySelectorAnnotation.data.questionId,
                        });
                      }}
                      questionId={entitySelectorAnnotation.data.questionId}
                      selectedEntities={selectedEntities}
                      className="rounded-lg border p-4"
                    />
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

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
                const raw = sanitizeText(part.text);
                const text =
                  message.role === "assistant"
                    ? raw.replace(/【(\d+)】/g, "")
                    : raw;
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
                        citationHrefs={undefined}
                        citationHrefsKey={undefined}
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

          {citationSources.length > 0 && (
            <div className="mt-4 flex flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground">
                Citations
              </div>
              <div className="flex flex-wrap gap-2">
                {citationSources.map((source, i) => {
                  const citationNumber = i + 1;
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
    if (!equal(prevProps.selectedEntities, nextProps.selectedEntities)) {
      return false;
    }
    if (!equal(prevProps.selectedTimeRange, nextProps.selectedTimeRange)) {
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
  const [randomMessage, setRandomMessage] = useState("");

  useEffect(() => {
    setRandomMessage(getRandomThinkingMessage());
  }, []);

  const displayText =
    agentStatus && agentStatus.message.trim().length > 0
      ? agentStatus.message
      : randomMessage || "Thinking";

  return (
    <div
      className="group/message fade-in w-full animate-in duration-300"
      data-role="assistant"
      data-testid="message-assistant-loading"
    >
      <div
        className={cn(
          "flex w-full min-w-0 items-center justify-start gap-0", 
        )}
      > 

        <div className="flex min-w-0 flex-1 flex-col gap-2 md:gap-4">
          <div className="flex min-w-0 items-center gap-1 p-0 text-muted-foreground text-sm leading-none">
            <span className="block animate-pulse truncate">{displayText}</span>
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
