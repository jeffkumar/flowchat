"use client";

import { Check, ChevronDown, Plus, Folder, Trash2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProjectSelector } from "@/hooks/use-project-selector";
import { cn } from "@/lib/utils";
import { CreateProjectDialog } from "./create-project-dialog";
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
import { toast } from "sonner";

export function ProjectSwitcher({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const {
    projects,
    selectedProjectId,
    setSelectedProjectId,
    selectedProject,
    mutate,
  } = useProjectSelector();
  const [showCreateDialog, setShowCreateDialog] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);

  const handleDeleteProject = async (projectId: string) => {
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to delete project");
      }

      toast.success("Project deleted");
      mutate();

      if (selectedProjectId === projectId) {
        setSelectedProjectId(null);
      }
    } catch (_error) {
      toast.error("Failed to delete project");
    } finally {
      setDeleteId(null);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className={cn("w-[200px] justify-between px-2", className)}
            variant="outline"
          >
            <div className="flex items-center gap-2 truncate">
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {selectedProject?.name || "Select project..."}
              </span>
            </div>
            <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-[200px]">
          <DropdownMenuLabel>Projects</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup className="max-h-[200px] overflow-y-auto">
            {projects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                className="justify-between group cursor-pointer"
                onSelect={() => {
                  setSelectedProjectId(project.id);
                  if (pathname.startsWith("/chat/")) {
                    router.push("/");
                    router.refresh();
                  }
                }}
              >
                <div className="flex items-center truncate">
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4 shrink-0",
                      selectedProjectId === project.id
                        ? "opacity-100"
                        : "opacity-0"
                    )}
                  />
                  <span className="truncate">{project.name}</span>
                </div>
                {!project.isDefault && (
                  <div
                    className="p-1 hover:bg-destructive/10 text-muted-foreground hover:text-destructive rounded opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setDeleteId(project.id);
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        e.preventDefault();
                        setDeleteId(project.id);
                      }
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </div>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setShowCreateDialog(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Create Project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateProjectDialog
        onOpenChange={setShowCreateDialog}
        open={showCreateDialog}
      />
      <AlertDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
      >
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
              onClick={() => deleteId && handleDeleteProject(deleteId)}
              className="bg-destructive hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
