"use client";

import { useState } from "react";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { ProjectSwitcher } from "@/components/project-switcher";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Settings, Settings2 } from "lucide-react";
import { ViewDocs } from "@/components/view-docs";
import { useProjectSelector } from "@/hooks/use-project-selector";

export function IntegrationsHeader() {
  const [isViewDocsOpen, setIsViewDocsOpen] = useState(false);
  const [ignoredDocIds, setIgnoredDocIds] = useState<string[]>([]);
  const { selectedProject } = useProjectSelector();

  return (
    <>
      <header className="sticky top-0 z-10 flex items-center gap-2 bg-background px-2 py-1.5 md:px-2">
        <SidebarToggle />
        <ProjectSwitcher />
        <div className="ml-auto flex items-center gap-1">
          <Button disabled size="sm" type="button" variant="outline">
            Integrations
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1" type="button">
                <Settings size={14} className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>
                Settings for {selectedProject?.name ?? "project"}
              </DropdownMenuLabel>
              <div className="px-2 pb-2 text-xs text-muted-foreground">
                Configure retrieval and documents for this project.
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setIsViewDocsOpen(true)}>
                <Settings2 className="mr-2 h-4 w-4" />
                Manage Documents...
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <ViewDocs
        isOpen={isViewDocsOpen}
        onOpenChange={setIsViewDocsOpen}
        ignoredDocIds={ignoredDocIds}
        setIgnoredDocIds={setIgnoredDocIds}
      />
    </>
  );
}


