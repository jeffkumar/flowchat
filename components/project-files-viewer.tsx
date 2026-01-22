"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { useSession } from "next-auth/react";
import { format } from "date-fns";
import { EyeIcon, EyeOffIcon, LoaderIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";

import type { ProjectDoc } from "@/lib/db/schema";
import {
  fetcher,
  readIgnoredDocIdsForProject,
  writeIgnoredDocIdsForProject,
} from "@/lib/utils";
import { useProjectSelector } from "@/hooks/use-project-selector";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { OneDriveIcon } from "@/components/icons";

type MembersResponse = {
  members: Array<
    | { kind: "user"; userId: string; email: string; role: "owner" | "admin" | "member" }
    | { kind: "invite"; email: string; role: "admin" | "member" }
  >;
};

type MicrosoftStatus = { connected: boolean };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function ProjectFilesViewer() {
  const { data: session } = useSession();
  const { selectedProjectId } = useProjectSelector();
  const [ignoredDocIds, setIgnoredDocIds] = useState<string[]>([]);

  // Local-only persistence per project.
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

  const { data, isLoading, mutate } = useSWR<{ docs: ProjectDoc[] }>(
    selectedProjectId ? `/api/projects/${selectedProjectId}/docs` : null,
    fetcher
  );

  const { data: membersData } = useSWR<MembersResponse>(
    selectedProjectId ? `/api/projects/${selectedProjectId}/members` : null,
    fetcher
  );

  const { data: msStatus } = useSWR<MicrosoftStatus>(
    "/api/integrations/microsoft/status",
    fetcher
  );

  const currentUserId = session?.user?.id ?? null;
  const role = useMemo(() => {
    if (!currentUserId) return null;
    const row = membersData?.members?.find(
      (m) => m.kind === "user" && m.userId === currentUserId
    );
    return row && row.kind === "user" ? row.role : null;
  }, [currentUserId, membersData?.members]);

  const isAdmin = role === "owner" || role === "admin";
  const msConnected = Boolean(msStatus?.connected);

  const toggleDocVisibility = (docId: string) => {
    setIgnoredDocIds((prev) =>
      prev.includes(docId) ? prev.filter((id) => id !== docId) : [...prev, docId]
    );
  };

  const deleteDoc = (doc: ProjectDoc) => {
    if (!selectedProjectId) {
      toast.error("No project selected");
      return;
    }

    const deletePromise = fetch(`/api/projects/${selectedProjectId}/docs/${doc.id}`, {
      method: "DELETE",
    }).then(async (response) => {
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
        setIgnoredDocIds((prev) => prev.filter((id) => id !== doc.id));
        void mutate();
        return "Document deleted";
      },
      error: (error) =>
        error instanceof Error ? error.message : "Failed to delete document",
    });
  };

  const syncMicrosoftDoc = (doc: ProjectDoc) => {
    if (!selectedProjectId) {
      toast.error("No project selected");
      return;
    }
    if (!isAdmin) {
      toast.error("Only project admins can sync integration files");
      return;
    }
    if (!msConnected) {
      toast.error("Connect Microsoft first to sync files");
      return;
    }

    const metadata =
      doc.metadata && typeof doc.metadata === "object"
        ? (doc.metadata as Record<string, unknown>)
        : null;
    const driveId = metadata && isNonEmptyString(metadata.driveId) ? metadata.driveId : null;
    const itemId = metadata && isNonEmptyString(metadata.itemId) ? metadata.itemId : null;
    if (!driveId || !itemId) {
      toast.error("Missing SharePoint/OneDrive metadata for this document");
      return;
    }

    const syncPromise = fetch(
      `/api/projects/${selectedProjectId}/integrations/microsoft/sync`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          driveId,
          items: [{ itemId, filename: doc.filename }],
          documentType: doc.documentType,
        }),
      }
    ).then(async (response) => {
      if (!response.ok) {
        const json = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(json?.error ?? "Failed to sync document");
      }
    });

    toast.promise(syncPromise, {
      loading: "Syncing file...",
      success: () => {
        void mutate();
        return "Sync started";
      },
      error: (error) =>
        error instanceof Error ? error.message : "Failed to sync document",
    });
  };

  const docs = data?.docs ?? [];

  return (
    <div className="rounded-2xl border border-border bg-background">
      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <LoaderIcon className="animate-spin text-muted-foreground" />
        </div>
      ) : docs.length === 0 ? (
        <div className="py-10 text-center text-muted-foreground">
          No documents found for this project.
        </div>
      ) : (
        <ScrollArea className="h-[65vh]">
          <div className="space-y-4 p-4">
            {docs.map((doc) => {
              const isIgnored = ignoredDocIds.includes(doc.id);
              const metadata =
                doc.metadata && typeof doc.metadata === "object"
                  ? (doc.metadata as Record<string, unknown>)
                  : null;
              const sourceWebUrl =
                metadata && isNonEmptyString(metadata.sourceWebUrl)
                  ? metadata.sourceWebUrl
                  : "";
              const driveId = metadata && isNonEmptyString(metadata.driveId) ? metadata.driveId : "";
              const itemId = metadata && isNonEmptyString(metadata.itemId) ? metadata.itemId : "";
              const sourceLower = sourceWebUrl.toLowerCase();
              const isMicrosoftSource =
                Boolean(driveId && itemId) ||
                sourceLower.includes("sharepoint.com") ||
                sourceLower.includes("onedrive");

              const canDelete =
                isAdmin || (currentUserId !== null && doc.createdBy === currentUserId);

              return (
                <div
                  key={doc.id}
                  className="flex items-center justify-between rounded-lg border bg-card p-3 text-card-foreground shadow-sm"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden">
                    <span className="truncate text-sm font-medium">{doc.filename}</span>
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(doc.createdAt), "PP")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {doc.documentType} · {doc.parseStatus}
                    </span>
                    {isMicrosoftSource && sourceWebUrl ? (
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

                    {isMicrosoftSource ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <Button
                              className="shrink-0"
                              disabled={!isAdmin || !msConnected}
                              onClick={() => syncMicrosoftDoc(doc)}
                              size="icon"
                              title="Sync file"
                              type="button"
                              variant="ghost"
                            >
                              <RefreshCwIcon className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          </span>
                        </TooltipTrigger>
                        {!isAdmin ? (
                          <TooltipContent side="top">
                            Only project admins can sync integration files.
                          </TooltipContent>
                        ) : !msConnected ? (
                          <TooltipContent side="top">
                            Connect Microsoft to sync files.
                          </TooltipContent>
                        ) : null}
                      </Tooltip>
                    ) : null}

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>
                          <Button
                            className="shrink-0"
                            disabled={!canDelete}
                            onClick={() => deleteDoc(doc)}
                            size="icon"
                            title={canDelete ? "Delete document" : "Only admins can delete this"}
                            type="button"
                            variant="ghost"
                          >
                            <Trash2Icon className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        </span>
                      </TooltipTrigger>
                      {!canDelete ? (
                        <TooltipContent side="top">
                          Only admins can delete documents added by others.
                        </TooltipContent>
                      ) : null}
                    </Tooltip>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

