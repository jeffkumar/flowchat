"use client";

import { useProjectSelector } from "@/hooks/use-project-selector";
import useSWR from "swr";
import { fetcher } from "@/lib/utils";
import type { ProjectDoc } from "@/lib/db/schema";
import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EyeIcon, EyeOffIcon, LoaderIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";
import { toast } from "sonner";
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
import { OneDriveIcon } from "@/components/icons";

interface ViewDocsProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  ignoredDocIds: string[];
  setIgnoredDocIds: (ids: string[]) => void;
}

export function ViewDocs({
  isOpen,
  onOpenChange,
  ignoredDocIds,
  setIgnoredDocIds,
}: ViewDocsProps) {
  const { selectedProjectId, selectedProject } = useProjectSelector();
  const [docToDelete, setDocToDelete] = useState<ProjectDoc | null>(null);
  const [showClearAllDialog, setShowClearAllDialog] = useState(false);

  const { data, isLoading, mutate } = useSWR<{ docs: ProjectDoc[] }>(
    selectedProjectId ? `/api/projects/${selectedProjectId}/docs` : null,
    fetcher
  );

  const toggleDocVisibility = (docId: string) => {
    if (ignoredDocIds.includes(docId)) {
      setIgnoredDocIds(ignoredDocIds.filter((id) => id !== docId));
    } else {
      setIgnoredDocIds([...ignoredDocIds, docId]);
    }
  };

  const truncateFilename = (filename: string, maxChars = 20) => {
    if (filename.length <= maxChars) return filename;
    return `${filename.slice(0, maxChars)}…`;
  };

  const projectName = selectedProject?.name ?? "";

  const deleteDoc = (doc: ProjectDoc) => {
    if (!selectedProjectId) {
      toast.error("No project selected");
      return;
    }

    const deletePromise = fetch(
      `/api/projects/${selectedProjectId}/docs/${doc.id}`,
      { method: "DELETE" }
    ).then(async (response) => {
      if (!response.ok) {
        const json = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(json?.error ?? "Failed to delete document");
      }
    });

    toast.promise(deletePromise, {
      loading: "Deleting document...",
      success: () => {
        setIgnoredDocIds(ignoredDocIds.filter((id) => id !== doc.id));
        void mutate();
        setDocToDelete(null);
        return "Document deleted";
      },
      error: (error) =>
        error instanceof Error ? error.message : "Failed to delete document",
    });
  };

  const clearAllDocs = () => {
    if (!selectedProjectId) {
      toast.error("No project selected");
      return;
    }

    const clearPromise = fetch(`/api/projects/${selectedProjectId}/docs/clear`, {
      method: "POST",
    }).then(async (response) => {
      if (!response.ok) {
        const json = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(json?.error ?? "Failed to clear documents");
      }
    });

    toast.promise(clearPromise, {
      loading: "Clearing documents...",
      success: () => {
        setIgnoredDocIds([]);
        void mutate();
        setShowClearAllDialog(false);
        return "All documents cleared";
      },
      error: (error) =>
        error instanceof Error ? error.message : "Failed to clear documents",
    });
  };

  return (
    <Sheet open={isOpen} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[400px] sm:w-[540px] flex flex-col">
        <SheetHeader>
          <SheetTitle>{projectName || "Project"}</SheetTitle>
          <SheetDescription>
            Manage documents for this chat.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-hidden mt-6">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <LoaderIcon className="animate-spin text-muted-foreground" />
            </div>
          ) : data?.docs?.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              No documents found for this project.
            </div>
          ) : (
            <ScrollArea className="h-full">
              <div className="space-y-4 pr-4">
                {data?.docs?.map((doc) => {
                  const isIgnored = ignoredDocIds.includes(doc.id);
                  const displayFilename = truncateFilename(doc.filename, 20);
                  const isTruncated = displayFilename !== doc.filename;
                  const metadata =
                    doc.metadata && typeof doc.metadata === "object"
                      ? (doc.metadata as Record<string, unknown>)
                      : null;
                  const sourceWebUrl =
                    metadata && typeof metadata.sourceWebUrl === "string"
                      ? metadata.sourceWebUrl
                      : "";
                  const driveId =
                    metadata && typeof metadata.driveId === "string" ? metadata.driveId : "";
                  const itemId =
                    metadata && typeof metadata.itemId === "string" ? metadata.itemId : "";
                  const sourceLower = sourceWebUrl.toLowerCase();
                  const isMicrosoftSource =
                    Boolean(driveId && itemId) ||
                    sourceLower.includes("sharepoint.com") ||
                    sourceLower.includes("onedrive");
                  return (
                    <div
                      key={doc.id}
                      className="flex items-center justify-between p-3 rounded-lg border bg-card text-card-foreground shadow-sm"
                    >
                      <div className="flex flex-1 min-w-0 flex-col gap-1 overflow-hidden">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className="text-sm font-medium truncate cursor-help select-none"
                              title={isTruncated ? undefined : doc.filename}
                            >
                              {displayFilename}
                            </span>
                          </TooltipTrigger>
                          {isTruncated && (
                            <TooltipContent side="top">{doc.filename}</TooltipContent>
                          )}
                        </Tooltip>
                        <span className="text-xs text-muted-foreground">
                          {format(new Date(doc.createdAt), "PP")}
                        </span>
                        {isMicrosoftSource && sourceWebUrl ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <a
                                className="flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2"
                                href={sourceWebUrl}
                                rel="noopener noreferrer"
                                target="_blank"
                              >
                                <span className="text-onedrive" title="SharePoint / OneDrive">
                                  <OneDriveIcon size={14} />
                                </span>
                                SharePoint / OneDrive
                              </a>
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              This file is stored in Sharepoint / Onedrive. 
                            </TooltipContent>
                          </Tooltip>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          className="shrink-0"
                          onClick={() => toggleDocVisibility(doc.id)}
                          size="icon"
                          title={isIgnored ? "Show in context" : "Hide from context"}
                          type="button"
                          variant="ghost"
                        >
                          {isIgnored ? (
                            <EyeOffIcon className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <EyeIcon className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          className="shrink-0"
                          onClick={() => setDocToDelete(doc)}
                          size="icon"
                          title={isMicrosoftSource ? "Remove from context" : "Delete document"}
                          type="button"
                          variant="ghost"
                        >
                          <Trash2Icon className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </div>

        <div className="mt-4 flex items-center justify-end border-t pt-3">
          <Button
            className="h-8 px-2 text-xs"
            onClick={() => setShowClearAllDialog(true)}
            size="sm"
            type="button"
            variant="destructive"
          >
            Clear all docs
          </Button>
        </div>
      </SheetContent>

      <AlertDialog onOpenChange={(open) => !open && setDocToDelete(null)} open={docToDelete !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            {(() => {
              const metadata =
                docToDelete?.metadata && typeof docToDelete.metadata === "object"
                  ? (docToDelete.metadata as Record<string, unknown>)
                  : null;
              const sourceWebUrl =
                metadata && typeof metadata.sourceWebUrl === "string"
                  ? metadata.sourceWebUrl
                  : "";
              const driveId =
                metadata && typeof metadata.driveId === "string" ? metadata.driveId : "";
              const itemId =
                metadata && typeof metadata.itemId === "string" ? metadata.itemId : "";
              const sourceLower = sourceWebUrl.toLowerCase();
              const isMicrosoftSource =
                Boolean(driveId && itemId) ||
                sourceLower.includes("sharepoint.com") ||
                sourceLower.includes("onedrive");

              return (
                <>
                  <AlertDialogTitle>
                    {isMicrosoftSource ? "Remove from context?" : "Delete document?"}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {isMicrosoftSource
                      ? "This will remove the file from Flowchat context and delete its stored copy and indexed content. This does not delete the file in SharePoint/OneDrive."
                      : "This action cannot be undone. This will permanently delete the file, remove it from storage, and remove its indexed content."}
                  </AlertDialogDescription>
                </>
              );
            })()}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (docToDelete) {
                  deleteDoc(docToDelete);
                }
              }}
              type="button"
            >
              {(() => {
                const metadata =
                  docToDelete?.metadata && typeof docToDelete.metadata === "object"
                    ? (docToDelete.metadata as Record<string, unknown>)
                    : null;
                const sourceWebUrl =
                  metadata && typeof metadata.sourceWebUrl === "string"
                    ? metadata.sourceWebUrl
                    : "";
                const driveId =
                  metadata && typeof metadata.driveId === "string" ? metadata.driveId : "";
                const itemId =
                  metadata && typeof metadata.itemId === "string" ? metadata.itemId : "";
                const sourceLower = sourceWebUrl.toLowerCase();
                const isMicrosoftSource =
                  Boolean(driveId && itemId) ||
                  sourceLower.includes("sharepoint.com") ||
                  sourceLower.includes("onedrive");
                return isMicrosoftSource ? "Remove" : "Delete";
              })()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        onOpenChange={setShowClearAllDialog}
        open={showClearAllDialog}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all documents?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete all docs
              in this project and remove their indexed content.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={clearAllDocs} type="button">
              Clear all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}

