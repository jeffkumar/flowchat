"use client";

import { useState } from "react";
import useSWR from "swr";
import { format } from "date-fns";
import { FileText, LoaderIcon, Pencil, Plus, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import type { ProjectDoc } from "@/lib/db/schema";
import { fetcher } from "@/lib/utils";
import { useProjectSelector } from "@/hooks/use-project-selector";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export function NotesViewer() {
  const router = useRouter();
  const { selectedProjectId } = useProjectSelector();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [newNoteTitle, setNewNoteTitle] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const { data, isLoading, mutate } = useSWR<{ notes: ProjectDoc[] }>(
    selectedProjectId ? `/api/projects/${selectedProjectId}/notes` : null,
    fetcher
  );

  const handleCreateNote = async () => {
    if (!selectedProjectId || !newNoteTitle.trim()) return;

    setIsCreating(true);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newNoteTitle.trim(), content: "" }),
      });

      if (!response.ok) {
        const json = await response.json().catch(() => null);
        throw new Error(json?.error ?? "Failed to create note");
      }

      const { note } = await response.json();
      toast.success("Note created");
      setIsCreateDialogOpen(false);
      setNewNoteTitle("");
      void mutate();

      // Navigate to the new note
      window.location.href = `/project-files/notes/${note.id}`;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create note");
    } finally {
      setIsCreating(false);
    }
  };

  const handleDeleteNote = async (noteId: string) => {
    if (!selectedProjectId) return;

    const deletePromise = fetch(
      `/api/projects/${selectedProjectId}/notes/${noteId}`,
      { method: "DELETE" }
    ).then(async (response) => {
      if (!response.ok) {
        const json = await response.json().catch(() => null);
        throw new Error(json?.error ?? "Failed to delete note");
      }
    });

    toast.promise(deletePromise, {
      loading: "Deleting note...",
      success: () => {
        void mutate();
        return "Note deleted";
      },
      error: (error) =>
        error instanceof Error ? error.message : "Failed to delete note",
    });
  };

  const notes = data?.notes ?? [];

  return (
    <div className="rounded-2xl border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border p-4">
        <h2 className="text-sm font-medium">Project Notes</h2>
        <Button
          size="sm"
          onClick={() => setIsCreateDialogOpen(true)}
          disabled={!selectedProjectId}
        >
          <Plus className="mr-1 h-4 w-4" />
          New Note
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <LoaderIcon className="animate-spin text-muted-foreground" />
        </div>
      ) : notes.length === 0 ? (
        <div className="py-10 text-center text-muted-foreground">
          No notes found. Create your first note to get started.
        </div>
      ) : (
        <ScrollArea className="h-[50vh]">
          <div className="space-y-2 p-4">
            {notes.map((note) => (
              <div
                key={note.id}
                className="flex items-center justify-between rounded-lg border bg-card p-3 text-card-foreground shadow-sm hover:bg-accent/50 transition-colors"
              >
                <Link
                  href={`/project-files/notes/${note.id}`}
                  className="flex min-w-0 flex-1 items-center gap-3"
                >
                  <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">
                      {note.description || note.filename}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(note.createdAt), "PP")}
                    </span>
                  </div>
                </Link>

                <div className="flex items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={(e) => {
                      e.preventDefault();
                      router.push(`/project-files/notes/${note.id}`);
                    }}
                    title="Edit note"
                  >
                    <Pencil className="h-4 w-4 text-muted-foreground" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={(e) => {
                      e.preventDefault();
                      handleDeleteNote(note.id);
                    }}
                    title="Delete note"
                  >
                    <Trash2Icon className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}

      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Note</DialogTitle>
            <DialogDescription>
              Enter a title for your new markdown note.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="Note title..."
              value={newNoteTitle}
              onChange={(e) => setNewNoteTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newNoteTitle.trim()) {
                  handleCreateNote();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsCreateDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateNote}
              disabled={!newNoteTitle.trim() || isCreating}
            >
              {isCreating ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
