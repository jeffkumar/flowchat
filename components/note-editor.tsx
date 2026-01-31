"use client";

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import { ArrowLeft, Check, LoaderIcon, Save } from "lucide-react";
import Link from "next/link";

import type { ProjectDoc } from "@/lib/db/schema";
import { fetcher } from "@/lib/utils";
import { useProjectSelector } from "@/hooks/use-project-selector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { ProjectSwitcher } from "@/components/project-switcher";

type NoteWithContent = ProjectDoc & { content: string };

export function NoteEditor({ noteId }: { noteId: string }) {
  const { selectedProjectId } = useProjectSelector();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const { data, isLoading, error } = useSWR<{ note: NoteWithContent }>(
    selectedProjectId ? `/api/projects/${selectedProjectId}/notes/${noteId}` : null,
    fetcher
  );

  useEffect(() => {
    if (data?.note) {
      setTitle(data.note.description || data.note.filename.replace(/\.md$/, ""));
      setContent(data.note.content || "");
      setHasChanges(false);
      setJustSaved(false);
    }
  }, [data]);

  const handleSave = useCallback(async () => {
    if (!selectedProjectId || isSaving) return;

    setIsSaving(true);
    try {
      const response = await fetch(
        `/api/projects/${selectedProjectId}/notes/${noteId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, content }),
        }
      );

      if (!response.ok) {
        const json = await response.json().catch(() => null);
        throw new Error(json?.error ?? "Failed to save note");
      }

      toast.success("Note saved");
      setHasChanges(false);
      setJustSaved(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save note");
    } finally {
      setIsSaving(false);
    }
  }, [selectedProjectId, noteId, title, content, isSaving]);

  // Keyboard shortcut: Ctrl+S / Cmd+S to save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (hasChanges && !isSaving) {
          handleSave();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasChanges, isSaving, handleSave]);

  const handleTitleChange = (value: string) => {
    setTitle(value);
    setHasChanges(true);
    setJustSaved(false);
  };

  const handleContentChange = (value: string) => {
    setContent(value);
    setHasChanges(true);
    setJustSaved(false);
  };

  if (isLoading) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <LoaderIcon className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data?.note) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">Note not found</p>
        <Button variant="outline" asChild>
          <Link href="/project-files/notes">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Notes
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-2 py-1.5 md:px-4">
        <SidebarToggle />
        <ProjectSwitcher />

        <Button variant="ghost" size="sm" asChild className="gap-1.5">
          <Link href="/project-files/notes">
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Back</span>
          </Link>
        </Button>

        <div className="ml-auto flex items-center gap-2">
          {hasChanges ? (
            <span className="text-xs text-muted-foreground">Unsaved changes</span>
          ) : justSaved ? (
            <span className="flex items-center gap-1 text-xs text-green-600">
              <Check className="h-3 w-3" />
              Saved
            </span>
          ) : null}
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isSaving || !hasChanges}
          >
            {isSaving ? (
              <LoaderIcon className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-1 h-4 w-4" />
            )}
            Save
          </Button>
        </div>
      </header>

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="border-b border-border px-4 py-4">
          <label htmlFor="note-title" className="block text-xs font-medium text-muted-foreground mb-1.5">
            Title
          </label>
          <Input
            id="note-title"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            placeholder="Enter note title..."
            className="text-xl font-semibold"
          />
        </div>

        <div className="flex-1 overflow-auto p-4">
          <label htmlFor="note-content" className="block text-xs font-medium text-muted-foreground mb-1.5">
            Content
          </label>
          <textarea
            id="note-content"
            value={content}
            onChange={(e) => handleContentChange(e.target.value)}
            placeholder="Start writing your note in markdown..."
            className="h-full w-full resize-none rounded-md border border-border bg-transparent p-3 font-mono text-sm leading-relaxed outline-none ring-offset-background placeholder:text-muted-foreground focus:ring-2 focus:ring-ring focus:ring-offset-2"
            style={{ minHeight: "calc(100vh - 250px)" }}
          />
        </div>
      </div>
    </div>
  );
}
