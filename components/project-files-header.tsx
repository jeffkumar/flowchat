"use client";

import { ProjectSwitcher } from "@/components/project-switcher";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { ShareProjectDialog } from "@/components/share-project-dialog";
import { Button } from "@/components/ui/button";
import { useProjectSelector } from "@/hooks/use-project-selector";
import { UserPlus } from "lucide-react";
import { useState } from "react";

export function ProjectFilesHeader() {
  const [isShareOpen, setIsShareOpen] = useState(false);
  const { selectedProjectId } = useProjectSelector();

  return (
    <>
      <header className="sticky top-0 z-10 flex items-center gap-2 bg-background px-2 py-1.5 md:px-2">
        <SidebarToggle />
        <ProjectSwitcher />
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            type="button"
            variant="outline"
            disabled={!selectedProjectId}
            onClick={() => setIsShareOpen(true)}
          >
            <UserPlus className="mr-2 h-4 w-4" />
            Add people
          </Button>
        </div>
      </header>

      {selectedProjectId && (
        <ShareProjectDialog
          projectId={selectedProjectId}
          open={isShareOpen}
          onOpenChange={setIsShareOpen}
        />
      )}
    </>
  );
}

