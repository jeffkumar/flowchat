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
import type { Attachment, ChatMessage, RetrievedSource, EntityOption } from "@/lib/types";
import type { AppUsage } from "@/lib/usage";
import {
  fetcher,
  fetchWithErrorHandlers,
  generateUUID,
  readIgnoredDocIdsForProject,
  writeIgnoredDocIdsForProject,
} from "@/lib/utils";
import { useRetrievalSettings } from "@/hooks/use-retrieval-settings";
import { Artifact } from "./artifact";
import { EntitySelector } from "./entity-selector";
import { useDataStream } from "./data-stream-provider";
import { Messages } from "./messages";
import { MultimodalInput } from "./multimodal-input";
import { getChatHistoryPaginationKey } from "./sidebar-history";
import { toast } from "./toast";
import type { VisibilityType } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type UploadDocumentType =
  | "general_doc"
  | "bank_statement"
  | "cc_statement"
  | "invoice";

function normalizeBusinessName(value: string): string {
  return value.trim();
}

function includesCaseInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const v = value.trim();
    if (v.length === 0) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function BusinessNameTypeahead({
  value,
  onChange,
  options,
  inputId,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  options: string[];
  inputId: string;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const query = normalizeBusinessName(value);
  const normalizedOptions = uniqueStrings(options);
  const filtered =
    query.length === 0
      ? normalizedOptions.slice(0, 8)
      : normalizedOptions
          .filter((name) => includesCaseInsensitive(name, query))
          .slice(0, 8);
  const shouldShow = open && filtered.length > 0;

  return (
    <Popover open={shouldShow} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Input
          autoComplete="off"
          id={inputId}
          onBlur={() => {
            window.setTimeout(() => setOpen(false), 120);
          }}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          value={value}
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[--radix-popover-trigger-width] p-1"
        sideOffset={4}
      >
        <div className="max-h-48 overflow-auto">
          {filtered.map((name) => (
            <Button
              key={name}
              className="h-8 w-full justify-start px-2 text-sm"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(name);
                setOpen(false);
              }}
              type="button"
              variant="ghost"
            >
              {name}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

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

  // Persist ignored docs locally per-project (device-local).
  useEffect(() => {
    if (!selectedProjectId) {
      setIgnoredDocIds([]);
      return;
    }
    setIgnoredDocIds(readIgnoredDocIdsForProject(selectedProjectId));
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) return;
    writeIgnoredDocIdsForProject(selectedProjectId, ignoredDocIds);
  }, [ignoredDocIds, selectedProjectId]);

  const [showCitations, setShowCitations] = useState(true);
  const [pendingSources, setPendingSources] = useState<RetrievedSource[] | null>(
    null
  );
  const pendingSourcesRef = useRef<RetrievedSource[] | null>(null);

  const pendingChartDocumentRef = useRef<{ id: string; title: string } | null>(
    null
  );

  const [selectedEntities, setSelectedEntities] = useState<EntityOption[]>([]);
  const selectedEntitiesRef = useRef<EntityOption[]>([]);
  const [entitySelectorData, setEntitySelectorData] = useState<{
    availableEntities: EntityOption[];
    questionId?: string;
  } | null>(null);

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
            selectedEntities: selectedEntitiesRef.current,
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
      if (dataPart.type === "data-chartDocument") {
        pendingChartDocumentRef.current = { id: dataPart.data.id, title: dataPart.data.title };
      }
      if (dataPart.type === "data-entitySelector") {
        setEntitySelectorData(dataPart.data);
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

      const chartDoc = pendingChartDocumentRef.current;
      if (chartDoc) {
        setMessages((prevMessages) => {
          const last = prevMessages[prevMessages.length - 1];
          if (last && last.role === "assistant") {
            const newAnnotations = [
              ...(last.annotations || []),
              { type: "chart-document", data: { documentId: chartDoc.id, title: chartDoc.title } },
            ];
            return [
              ...prevMessages.slice(0, -1),
              { ...last, annotations: newAnnotations },
            ];
          }
          return prevMessages;
        });
        pendingChartDocumentRef.current = null;
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
      pendingChartDocumentRef.current = null;
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

  useEffect(() => {
    selectedEntitiesRef.current = selectedEntities;
  }, [selectedEntities]);

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

  const [invoiceSender, setInvoiceSender] = useState("");
  const [invoiceRecipient, setInvoiceRecipient] = useState("");

  useEffect(() => {
    const sender = localStorage.getItem("invoice_sender_last");
    const recipient = localStorage.getItem("invoice_recipient_last");
    if (typeof sender === "string") setInvoiceSender(sender);
    if (typeof recipient === "string") setInvoiceRecipient(recipient);
  }, []);

  useEffect(() => {
    localStorage.setItem("invoice_sender_last", invoiceSender);
  }, [invoiceSender]);

  useEffect(() => {
    localStorage.setItem("invoice_recipient_last", invoiceRecipient);
  }, [invoiceRecipient]);

  const { data: invoiceParties } = useSWR<{
    senders: string[];
    recipients: string[];
  }>(
    selectedProjectId ? `/api/projects/${selectedProjectId}/invoices/parties` : null,
    fetcher
  );

  const { data: businessNamesData } = useSWR<{ names: string[] }>(
    "/api/entities/business-names",
    fetcher,
    { shouldRetryOnError: false }
  );

  const [isDragging, setIsDragging] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[]>([]);
  const [selectedFileType, setSelectedFileType] =
    useState<UploadDocumentType>("general_doc");
  const [dropEntityKind, setDropEntityKind] = useState<"personal" | "business">(
    "personal"
  );
  const [dropBusinessName, setDropBusinessName] = useState("");

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isReadonly) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (isReadonly) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      setDroppedFiles(files);
    }
  };

  const uploadFile = async (file: File, type: UploadDocumentType) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("documentType", type);
    formData.append("entityKind", dropEntityKind);
    if (dropEntityKind === "business") {
      const bn = dropBusinessName.trim();
      if (bn.length > 0) formData.append("entityName", bn);
    }
    if (type === "invoice") {
      const sender = invoiceSender.trim();
      const recipient = invoiceRecipient.trim();
      if (sender) formData.append("invoiceSender", sender);
      if (recipient) formData.append("invoiceRecipient", recipient);
    }
    if (selectedProjectId) {
      formData.append("projectId", selectedProjectId);
    }

    try {
      const response = await fetch("/api/files/upload", {
        method: "POST",
        body: formData,
      });

      if (response.ok) {
        const data = await response.json();
        const { url, pathname, contentType } = data;

        if (selectedProjectId) {
          mutate(`/api/projects/${selectedProjectId}/docs`);
        }

        return {
          url,
          name: pathname,
          contentType,
        };
      }
      const { error } = await response.json();
      toast({ type: "error", description: error });
    } catch (_error) {
      toast({
        type: "error",
        description: "Failed to upload file, please try again!",
      });
    }
  };

  const handleUploadDroppedFiles = async () => {
    const filesToUpload = [...droppedFiles];
    const type = selectedFileType;
    setDroppedFiles([]);

    try {
      const uploadPromises = filesToUpload.map((file) => uploadFile(file, type));
      const uploadedAttachments = await Promise.all(uploadPromises);
      const successfullyUploadedAttachments = uploadedAttachments.filter(
        (attachment): attachment is Attachment => attachment !== undefined
      );

      setAttachments((currentAttachments) => [
        ...currentAttachments,
        ...successfullyUploadedAttachments,
      ]);
    } catch (error) {
      console.error("Error uploading dropped files!", error);
    }
  };

  useAutoResume({
    autoResume,
    initialMessages,
    resumeStream,
    setMessages,
  });

  return (
    <>
      <div
        className={cn(
          "overscroll-behavior-contain flex h-dvh min-w-0 touch-pan-y flex-col bg-background dark:bg-auth-charcoal relative",
          isDragging && "ring-4 ring-primary ring-inset"
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm pointer-events-none">
            <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-primary bg-background p-8 shadow-xl">
              <p className="text-lg font-medium">Drop files to upload</p>
              <p className="text-sm text-muted-foreground">
                Release to select document type
              </p>
            </div>
          </div>
        )}

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

      {entitySelectorData && (
        <div className="mx-auto w-full max-w-4xl px-2 md:px-4">
          <EntitySelector
            availableEntities={entitySelectorData.availableEntities}
            onSelectionChange={(entities) => {
              setSelectedEntities(entities);
              setEntitySelectorData(null);
              if (entities.length > 0) {
                // Auto-submit the query with selected entities
                const lastUserMessage = messages
                  .slice()
                  .reverse()
                  .find((m) => m.role === "user");
                if (lastUserMessage) {
                  const questionText = lastUserMessage.parts
                    .filter((p) => p.type === "text")
                    .map((p) => p.text)
                    .join("\n");
                  sendMessage({
                    role: "user",
                    parts: [{ type: "text", text: questionText }],
                  });
                }
              }
            }}
            questionId={entitySelectorData.questionId}
            selectedEntities={selectedEntities}
          />
        </div>
      )}

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

      <Dialog
        open={droppedFiles.length > 0}
        onOpenChange={(open) => {
          if (!open) {
            setDroppedFiles([]);
            setDropEntityKind("personal");
            setDropBusinessName("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Files</DialogTitle>
            <DialogDescription>
              Select the type of document for the {droppedFiles.length} file(s)
              you dropped.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <div className="mb-2 text-sm font-medium">Document Type</div>
            <Select
              value={selectedFileType}
              onValueChange={(value) =>
                setSelectedFileType(value as UploadDocumentType)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="general_doc">General doc</SelectItem>
                <SelectItem value="bank_statement">Bank statement</SelectItem>
                <SelectItem value="cc_statement">
                  Credit card statement
                </SelectItem>
                <SelectItem value="invoice">Invoice</SelectItem>
              </SelectContent>
            </Select>

            <div className="mt-4 grid gap-3">
              <div className="grid gap-1">
                <label
                  className="text-xs text-muted-foreground"
                  htmlFor="chat-drop-entity-kind"
                >
                  Entity type
                </label>
                <Select
                  value={dropEntityKind}
                  onValueChange={(value) =>
                    setDropEntityKind(value as "personal" | "business")
                  }
                >
                  <SelectTrigger id="chat-drop-entity-kind">
                    <SelectValue placeholder="Select entity type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="personal">Personal</SelectItem>
                    <SelectItem value="business">Business</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {dropEntityKind === "business" ? (
                <div className="grid gap-1">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor="chat-drop-business-name"
                  >
                    Business name
                  </label>
                  <BusinessNameTypeahead
                    inputId="chat-drop-business-name"
                    onChange={setDropBusinessName}
                    options={businessNamesData?.names ?? []}
                    placeholder="Start typing a business name"
                    value={dropBusinessName}
                  />
                  <div className="text-[11px] text-muted-foreground">
                    Start typing to reuse an existing business name, or type a new one.
                  </div>
                </div>
              ) : null}
            </div>

            {selectedFileType === "invoice" && (
              <div className="mt-4 grid gap-3">
                <div className="grid gap-1">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor="chat-drop-invoice-sender"
                  >
                    Sender
                  </label>
                  <Input
                    autoComplete="off"
                    id="chat-drop-invoice-sender"
                    list="chat-drop-invoice-sender-options"
                    onChange={(e) => setInvoiceSender(e.target.value)}
                    placeholder="Select or type sender"
                    value={invoiceSender}
                  />
                  <datalist id="chat-drop-invoice-sender-options">
                    {(invoiceParties?.senders ?? []).map((value) => (
                      <option key={value} value={value} />
                    ))}
                  </datalist>
                </div>
                <div className="grid gap-1">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor="chat-drop-invoice-recipient"
                  >
                    Recipient
                  </label>
                  <Input
                    autoComplete="off"
                    id="chat-drop-invoice-recipient"
                    list="chat-drop-invoice-recipient-options"
                    onChange={(e) => setInvoiceRecipient(e.target.value)}
                    placeholder="Select or type recipient"
                    value={invoiceRecipient}
                  />
                  <datalist id="chat-drop-invoice-recipient-options">
                    {(invoiceParties?.recipients ?? []).map((value) => (
                      <option key={value} value={value} />
                    ))}
                  </datalist>
                </div>
              </div>
            )}

            <div className="mt-4 flex flex-col gap-1 max-h-40 overflow-y-auto rounded-md border p-2">
              {droppedFiles.map((file, i) => (
                <div key={`${file.name}-${i}`} className="text-xs truncate">
                  {file.name}
                </div>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDroppedFiles([])}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (dropEntityKind === "business" && dropBusinessName.trim().length === 0) {
                  toast({ type: "error", description: "Business name is required" });
                  return;
                }
                void handleUploadDroppedFiles();
              }}
            >
              Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
