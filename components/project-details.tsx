"use client";

import { useProjectSelector } from "@/hooks/use-project-selector";
import useSWR from "swr";
import { fetcher } from "@/lib/utils";
import type { ProjectDoc } from "@/lib/db/schema";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { format } from "date-fns";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { namespacesForSourceTypes } from "@/lib/rag/source-routing";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
import { useState } from "react";
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

function formatProjectDate(value: unknown) {
  if (value instanceof Date) {
    return format(value, "PPpp");
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "—";
    }
    return format(date, "PPpp");
  }
  return "—";
}

function tailWithEllipsis(value: string, tailChars = 8) {
  if (value.length <= tailChars) {
    return value;
  }
  return `…${value.slice(-tailChars)}`;
}

function ValueWithTooltip({
  displayValue,
  fullValue,
  className,
}: {
  displayValue: string;
  fullValue: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={className} title={fullValue}>
          {displayValue}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[420px] whitespace-normal break-all" side="top">
        {fullValue}
      </TooltipContent>
    </Tooltip>
  );
}

export function ProjectDetails({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { selectedProject, selectedProjectId, mutate, setSelectedProjectId } =
    useProjectSelector();
  const projectName = selectedProject?.name ?? "";
  const hideName =
    typeof projectName === "string" && projectName.trim().toLowerCase() === "default";

  const slackNamespace =
    selectedProject?.id
      ? namespacesForSourceTypes(["slack"], selectedProject.id, selectedProject.isDefault)[0]
      : "—";
  const docsNamespace =
    selectedProject?.id
      ? namespacesForSourceTypes(["docs"], selectedProject.id, selectedProject.isDefault)[0]
      : "—";

  const { data, isLoading } = useSWR<{ docs: ProjectDoc[] }>(
    selectedProjectId ? `/api/projects/${selectedProjectId}/docs` : null,
    fetcher
  );

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteProject = async () => {
    if (!selectedProjectId) return;

    setIsDeleting(true);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to delete project");
      }

      toast.success("Project deleted");
      onOpenChange(false);
      setSelectedProjectId(null); // Will trigger auto-selection of default
      mutate();
    } catch (_error) {
      toast.error("Failed to delete project");
    } finally {
      setIsDeleting(false);
      setShowDeleteDialog(false);
    }
  };

  return (
    <>
      <Sheet open={isOpen} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="w-[400px] sm:w-[540px] flex flex-col"
        >
          <SheetHeader>
            <SheetTitle>Project Details</SheetTitle>
            <SheetDescription>Details for the currently selected project.</SheetDescription>
          </SheetHeader>

          <div className="mt-6 space-y-3 text-sm">
            {!hideName && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Name</span>
                <span className="max-w-[60%] truncate text-right">
                  {selectedProject?.name ?? "—"}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Project ID</span>
              {selectedProject?.id ? (
                <ValueWithTooltip
                  className="max-w-[60%] truncate font-mono text-right"
                  displayValue={tailWithEllipsis(selectedProject.id, 8)}
                  fullValue={selectedProject.id}
                />
              ) : (
                <span className="max-w-[60%] truncate font-mono text-right">—</span>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Default</span>
              <span>{selectedProject?.isDefault ? "Yes" : "No"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Slack namespace</span>
              {slackNamespace !== "—" ? (
                <ValueWithTooltip
                  className="max-w-[60%] truncate font-mono text-right"
                  displayValue={tailWithEllipsis(slackNamespace, 8)}
                  fullValue={slackNamespace}
                />
              ) : (
                <span className="max-w-[60%] truncate font-mono text-right">—</span>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Docs namespace</span>
              {docsNamespace !== "—" ? (
                <ValueWithTooltip
                  className="max-w-[60%] truncate font-mono text-right"
                  displayValue={tailWithEllipsis(docsNamespace, 8)}
                  fullValue={docsNamespace}
                />
              ) : (
                <span className="max-w-[60%] truncate font-mono text-right">—</span>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Created</span>
              <span className="text-right">
                {formatProjectDate(selectedProject?.createdAt)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Documents</span>
              <span>
                {isLoading ? "Loading…" : (data?.docs?.length ?? 0).toString()}
              </span>
            </div>
          </div>

          {!selectedProject?.isDefault && (
            <div className="mt-auto pt-6">
              <Button
                variant="destructive"
                className="w-full"
                onClick={() => setShowDeleteDialog(true)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete Project
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Project</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this project? This action cannot be
              undone and will delete all associated files and chats.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteProject}
              className="bg-destructive hover:bg-destructive/90"
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
