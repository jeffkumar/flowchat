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
import { EyeIcon, EyeOffIcon, LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";

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
  const { selectedProjectId } = useProjectSelector();

  const { data, isLoading } = useSWR<{ docs: ProjectDoc[] }>(
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

  return (
    <Sheet open={isOpen} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[400px] sm:w-[540px] flex flex-col">
        <SheetHeader>
          <SheetTitle>Project Documents</SheetTitle>
          <SheetDescription>
            Manage visibility of documents for this chat.
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
                  return (
                    <div
                      key={doc.id}
                      className="flex items-center justify-between p-3 rounded-lg border bg-card text-card-foreground shadow-sm"
                    >
                      <div className="flex flex-col gap-1 overflow-hidden">
                        <span className="text-sm font-medium truncate" title={doc.filename}>
                          {doc.filename}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {format(new Date(doc.createdAt), "PP")}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => toggleDocVisibility(doc.id)}
                        className="shrink-0"
                        title={isIgnored ? "Show in context" : "Hide from context"}
                      >
                         {isIgnored ? (
                          <EyeOffIcon className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <EyeIcon className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

