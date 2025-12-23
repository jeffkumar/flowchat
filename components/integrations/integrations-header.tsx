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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Settings, Settings2 } from "lucide-react";
import { ViewDocs } from "@/components/view-docs";
import { useProjectSelector } from "@/hooks/use-project-selector";
import { useRetrievalSettings } from "@/hooks/use-retrieval-settings";
import type { RetrievalRangePreset } from "@/components/chat-header";

export function IntegrationsHeader() {
  const [isViewDocsOpen, setIsViewDocsOpen] = useState(false);
  const [ignoredDocIds, setIgnoredDocIds] = useState<string[]>([]);
  const { selectedProject } = useProjectSelector();
  const { retrievalRangePreset, setRetrievalRangePreset } = useRetrievalSettings();

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
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Time range</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={retrievalRangePreset}
                    onValueChange={(value) => {
                      if (
                        value === "all" ||
                        value === "1d" ||
                        value === "7d" ||
                        value === "30d" ||
                        value === "90d"
                      ) {
                        setRetrievalRangePreset(value as RetrievalRangePreset);
                      }
                    }}
                  >
                    <DropdownMenuRadioItem value="all">All time</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="1d">Last day</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="7d">Last 7 days</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="30d">Last 30 days</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="90d">Last 90 days</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
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


