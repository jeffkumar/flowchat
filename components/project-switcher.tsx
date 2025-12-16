"use client";

import { Check, ChevronDown, Plus } from "lucide-react";
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

export function ProjectSwitcher({ className }: { className?: string }) {
  const { projects, selectedProjectId, setSelectedProjectId, selectedProject } =
    useProjectSelector();
  const [showCreateDialog, setShowCreateDialog] = React.useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className={cn("w-[200px] justify-between", className)}
            variant="outline"
          >
            {selectedProject?.name || "Select project..."}
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
                onSelect={() => setSelectedProjectId(project.id)}
              >
                <Check
                  className={cn(
                    "mr-2 h-4 w-4",
                    selectedProjectId === project.id
                      ? "opacity-100"
                      : "opacity-0"
                  )}
                />
                {project.name}
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
    </>
  );
}
