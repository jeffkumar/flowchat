"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { unstable_serialize } from "swr/infinite";
import { ChatHeader, type RetrievalRangePreset } from "@/components/chat-header";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useArtifactSelector } from "@/hooks/use-artifact";
import { useAutoResume } from "@/hooks/use-auto-resume";
import { useChatVisibility } from "@/hooks/use-chat-visibility";
import { useProjectSelector } from "@/hooks/use-project-selector";
import type { Vote } from "@/lib/db/schema";
import { ChatSDKError } from "@/lib/errors";
import type { Attachment, ChatMessage, RetrievedSource } from "@/lib/types";
import type { AppUsage } from "@/lib/usage";
import { fetcher, fetchWithErrorHandlers, generateUUID } from "@/lib/utils";
import { useRetrievalSettings } from "@/hooks/use-retrieval-settings";
import { Artifact } from "./artifact";
import { useDataStream } from "./data-stream-provider";
import { Messages } from "./messages";
import { MultimodalInput } from "./multimodal-input";
import { getChatHistoryPaginationKey } from "./sidebar-history";
import { toast } from "./toast";
import type { VisibilityType } from "@/lib/types";

function getSourceTypes(includeSlack: boolean): Array<"slack" | "docs"> {
  return includeSlack ? ["slack", "docs"] : ["docs"];
}

function labelForPreset(preset: RetrievalRangePreset) {
  switch (preset) {
    case "all":
      return "All time";
    case "1d":
      return "Last day";
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "90d":
      return "Last 90 days";
    default: {
      const _exhaustive: never = preset;
      return _exhaustive;
    }
  }
}

export function Chat({
  id,
  initialMessages,
  initialChatModel,
  initialVisibilityType,
  isReadonly,
  autoResume,
  initialLastContext,
}: {
  id: string;
  initialMessages: ChatMessage[];
  initialChatModel: string;
  initialVisibilityType: VisibilityType;
  isReadonly: boolean;
  autoResume: boolean;
  initialLastContext?: AppUsage;
}) {
  const router = useRouter();

  const { visibilityType } = useChatVisibility({
    chatId: id,
    initialVisibilityType,
  });

  const { mutate } = useSWRConfig();

  // Handle browser back/forward navigation
  useEffect(() => {
    const handlePopState = () => {
      // When user navigates back/forward, refresh to sync with URL
      router.refresh();
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [router]);
  const { setDataStream } = useDataStream();

  const [input, setInput] = useState<string>("");
  const [usage, setUsage] = useState<AppUsage | undefined>(initialLastContext);
  const [showCreditCardAlert, setShowCreditCardAlert] = useState(false);
  const [currentModelId, setCurrentModelId] = useState(initialChatModel);
  const currentModelIdRef = useRef(currentModelId);
  const { selectedProjectId } = useProjectSelector();
  const selectedProjectIdRef = useRef(selectedProjectId);

  const {
    includeSlack,
    retrievalRangePreset,
    setRetrievalRangePreset,
  } = useRetrievalSettings();
  const sourceTypes = getSourceTypes(includeSlack);
  const sourceTypesRef = useRef(sourceTypes);
  const retrievalRangePresetRef = useRef(retrievalRangePreset);

  // Keep refs in sync during render so a quick toggle + send doesn't use stale values.
  sourceTypesRef.current = sourceTypes;

  const browserTimeZone =
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : "UTC";
  const browserTimeZoneRef = useRef(browserTimeZone);

  const [ignoredDocIds, setIgnoredDocIds] = useState<string[]>([]);
  const ignoredDocIdsRef = useRef(ignoredDocIds);

  const [showCitations, setShowCitations] = useState(true);
  const [pendingSources, setPendingSources] = useState<RetrievedSource[] | null>(
    null
  );
  const pendingSourcesRef = useRef<RetrievedSource[] | null>(null);

  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    regenerate,
    resumeStream,
  } = useChat<ChatMessage>({
    id,
    messages: initialMessages,
    experimental_throttle: 100,
    generateId: generateUUID,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      fetch: fetchWithErrorHandlers,
      prepareSendMessagesRequest(request) {
        return {
          body: {
            id: request.id,
            message: request.messages.at(-1),
            selectedChatModel: currentModelIdRef.current,
            selectedVisibilityType: visibilityType,
            sourceTypes: sourceTypesRef.current,
            projectId: selectedProjectIdRef.current,
            ignoredDocIds: ignoredDocIdsRef.current,
            retrievalRangePreset: retrievalRangePresetRef.current,
            retrievalTimeZone: browserTimeZoneRef.current,
            ...request.body,
          },
        };
      },
    }),
    onData: (dataPart) => {
      setDataStream((ds) => (ds ? [...ds, dataPart] : []));
      if (dataPart.type === "data-usage") {
        setUsage(dataPart.data);
      }
      if (dataPart.type === "data-sources") {
        pendingSourcesRef.current = dataPart.data;
        setPendingSources(dataPart.data);
      }
    },
    onFinish: (result) => {
      // If we have pending sources, attach them to the last message here
      // This is safe because the stream has finished
      const sourcesToAttach = pendingSourcesRef.current;
      if (sourcesToAttach) {
        setMessages((prevMessages) => {
          const last = prevMessages[prevMessages.length - 1];
          // We look for the last assistant message
          if (last && last.role === "assistant") {
            const newAnnotations = [
              ...(last.annotations || []),
              { type: "sources", data: sourcesToAttach },
            ];
            return [
              ...prevMessages.slice(0, -1),
              { ...last, annotations: newAnnotations },
            ];
          }
          return prevMessages;
        });
        pendingSourcesRef.current = null;
        setPendingSources(null);
      }

      mutate(
        unstable_serialize((index, previousPageData) =>
          getChatHistoryPaginationKey(
            index,
            previousPageData,
            selectedProjectIdRef.current
          )
        )
      );
    },
    onError: (error) => {
      if (error instanceof ChatSDKError) {
        // Check if it's a credit card error
        if (
          error.message?.includes("AI Gateway requires a valid credit card")
        ) {
          setShowCreditCardAlert(true);
        } else {
          toast({
            type: "error",
            description: error.message,
          });
        }
        return;
      }

      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Something went wrong. Please try again.";

      toast({
        type: "error",
        description: message.length > 300 ? `${message.slice(0, 300)}…` : message,
      });
    },
  });

  const statusRef = useRef(status);

  useEffect(() => {
    if (statusRef.current !== status && status === "submitted") {
      pendingSourcesRef.current = null;
      setPendingSources(null);
    }
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    currentModelIdRef.current = currentModelId;
  }, [currentModelId]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    retrievalRangePresetRef.current = retrievalRangePreset;
  }, [retrievalRangePreset]);

  useEffect(() => {
    browserTimeZoneRef.current = browserTimeZone;
  }, [browserTimeZone]);

  useEffect(() => {
    ignoredDocIdsRef.current = ignoredDocIds;
  }, [ignoredDocIds]);

  const searchParams = useSearchParams();
  const query = searchParams.get("query");

  const [hasAppendedQuery, setHasAppendedQuery] = useState(false);

  useEffect(() => {
    if (query && !hasAppendedQuery) {
      sendMessage({
        role: "user" as const,
        parts: [{ type: "text", text: query }],
      });

      setHasAppendedQuery(true);
      window.history.replaceState({}, "", `/chat/${id}`);
    }
  }, [query, sendMessage, hasAppendedQuery, id]);

  const { data: votes } = useSWR<Vote[]>(
    messages.length >= 2 ? `/api/vote?chatId=${id}` : null,
    fetcher
  );

  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const isArtifactVisible = useArtifactSelector((state) => state.isVisible);

  useAutoResume({
    autoResume,
    initialMessages,
    resumeStream,
    setMessages,
  });

  return (
    <>
      <div className="overscroll-behavior-contain flex h-dvh min-w-0 touch-pan-y flex-col bg-background dark:bg-auth-charcoal">
        <ChatHeader
          chatId={id}
          isReadonly={isReadonly}
          selectedVisibilityType={initialVisibilityType}
          ignoredDocIds={ignoredDocIds}
          setIgnoredDocIds={setIgnoredDocIds}
        />

        <Messages
          chatId={id}
          isArtifactVisible={isArtifactVisible}
          isReadonly={isReadonly}
          messages={messages}
          regenerate={regenerate}
          selectedModelId={initialChatModel}
          setMessages={setMessages}
          status={status}
          votes={votes}
          showCitations={showCitations}
        />

        <div className="sticky bottom-0 z-1 mx-auto flex w-full max-w-4xl flex-col gap-2 border-t-0 bg-background dark:bg-auth-charcoal px-2 pb-3 md:px-4 md:pb-4">
          {!isReadonly && (
            <>
              <div className="flex items-center justify-between gap-2 px-1">
                <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showCitations}
                    onChange={(e) => setShowCitations(e.target.checked)}
                    className="h-3 w-3 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground accent-primary"
                  />
                  Show citations
                </label>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      className="h-5 px-2 text-[10px] text-muted-foreground"
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {labelForPreset(retrievalRangePreset)}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40" side="top">
                    <DropdownMenuLabel>Time range</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuRadioGroup
                      value={retrievalRangePreset}
                      onValueChange={(value) => {
                        if (
                          value === "all" ||
                          value === "1d" ||
                          value === "7d" ||
                          value === "30d" ||
                          value === "90d"
                        ) {
                          setRetrievalRangePreset(value);
                        }
                      }}
                    >
                      <DropdownMenuRadioItem value="all">All time</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="1d">Last day</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="7d">Last 7 days</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="30d">Last 30 days</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="90d">Last 90 days</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <MultimodalInput
                attachments={attachments}
                chatId={id}
                input={input}
                messages={messages}
                onModelChange={setCurrentModelId}
                selectedModelId={currentModelId}
                selectedVisibilityType={visibilityType}
                sendMessage={sendMessage}
                setAttachments={setAttachments}
                setInput={setInput}
                setMessages={setMessages}
                status={status}
                stop={stop}
                selectedProjectId={selectedProjectId ?? undefined}
              />
            </>
          )}
        </div>
      </div>

      <Artifact
        attachments={attachments}
        chatId={id}
        input={input}
        isReadonly={isReadonly}
        messages={messages}
        regenerate={regenerate}
        selectedModelId={currentModelId}
        selectedVisibilityType={visibilityType}
        sendMessage={sendMessage}
        setAttachments={setAttachments}
        setInput={setInput}
        setMessages={setMessages}
        status={status}
        stop={stop}
        votes={votes}
      />

      <AlertDialog
        onOpenChange={setShowCreditCardAlert}
        open={showCreditCardAlert}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Activate AI Gateway</AlertDialogTitle>
            <AlertDialogDescription>
              This application requires{" "}
              {process.env.NODE_ENV === "production" ? "the owner" : "you"} to
              activate Vercel AI Gateway.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                window.open(
                  "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card",
                  "_blank"
                );
                window.location.href = "/";
              }}
            >
              Activate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
