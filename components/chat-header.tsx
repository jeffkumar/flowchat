"use client";
import { useRouter } from "next/navigation";
import { memo, useState } from "react";
import { useWindowSize } from "usehooks-ts";
import { ProjectSwitcher } from "@/components/project-switcher";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PlusIcon } from "./icons";
import { Settings, Settings2 } from "lucide-react";
import { useSidebar } from "./ui/sidebar";
import { ViewDocs } from "./view-docs";
import type { VisibilityType } from "@/lib/types";

export type RetrievalRangePreset = "all" | "1d" | "7d" | "30d" | "90d";

function PureChatHeader({
  chatId,
  selectedVisibilityType,
  isReadonly,
  ignoredDocIds,
  setIgnoredDocIds,
}: {
  chatId: string;
  selectedVisibilityType: VisibilityType;
  isReadonly: boolean;
  ignoredDocIds: string[];
  setIgnoredDocIds: (ids: string[]) => void;
}) {
  const router = useRouter();
  const { open } = useSidebar();
  const [isViewDocsOpen, setIsViewDocsOpen] = useState(false);

  const { width: windowWidth } = useWindowSize();

  return (
    <header className="sticky top-0 flex items-center gap-2 bg-background px-2 py-1.5 md:px-2">
      <SidebarToggle />
      <ProjectSwitcher />

      {(!open || windowWidth < 768) && (
        <Button
          className="order-2 ml-auto h-8 px-2 md:order-1 md:ml-0 md:h-fit md:px-2"
          onClick={() => {
            router.push("/");
            router.refresh();
          }}
          variant="outline"
        >
          <PlusIcon />
          <span className="md:sr-only">New Chat</span>
        </Button>
      )}

      {!isReadonly && (
        <div className="ml-auto flex items-center gap-1">
          <Button
            onClick={() => router.push("/integrations")}
            size="sm"
            type="button"
            variant="outline"
          >
            Integrations
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="gap-1" size="sm" type="button" variant="outline">
                <Settings size={14} className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>Settings</DropdownMenuLabel>
              <div className="px-2 pb-2 text-xs text-muted-foreground">
                Configure documents for this chat.
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setIsViewDocsOpen(true)}>
                <Settings2 className="mr-2 h-4 w-4" />
                Manage Documents...
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <ViewDocs
            isOpen={isViewDocsOpen}
            onOpenChange={setIsViewDocsOpen}
            ignoredDocIds={ignoredDocIds}
            setIgnoredDocIds={setIgnoredDocIds}
          />
        </div>
      )}
    </header>
  );
}

export const ChatHeader = memo(PureChatHeader, (prevProps, nextProps) => {
  return (
    prevProps.chatId === nextProps.chatId &&
    prevProps.selectedVisibilityType === nextProps.selectedVisibilityType &&
    prevProps.isReadonly === nextProps.isReadonly &&
    prevProps.ignoredDocIds === nextProps.ignoredDocIds &&
    prevProps.retrievalRangePreset === nextProps.retrievalRangePreset
  );
});
