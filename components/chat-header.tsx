"use client";
import { useRouter } from "next/navigation";
import { memo, useState } from "react";
import { useWindowSize } from "usehooks-ts";
import { ProjectSwitcher } from "@/components/project-switcher";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDownIcon, PlusIcon } from "./icons";
import { Settings2 } from "lucide-react";
import { useSidebar } from "./ui/sidebar";
import { ViewDocs } from "./view-docs";
import type { VisibilityType } from "./visibility-selector";

function PureChatHeader({
  chatId,
  selectedVisibilityType,
  isReadonly,
  sourceTypes,
  setSourceTypes,
  ignoredDocIds,
  setIgnoredDocIds,
}: {
  chatId: string;
  selectedVisibilityType: VisibilityType;
  isReadonly: boolean;
  sourceTypes: Array<"slack" | "docs">;
  setSourceTypes: (next: Array<"slack" | "docs">) => void;
  ignoredDocIds: string[];
  setIgnoredDocIds: (ids: string[]) => void;
}) {
  const router = useRouter();
  const { open } = useSidebar();
  const [isViewDocsOpen, setIsViewDocsOpen] = useState(false);

  const { width: windowWidth } = useWindowSize();

  const toggleSourceType = (type: "slack" | "docs") => {
    setSourceTypes(
      sourceTypes.includes(type)
        ? sourceTypes.filter((t) => t !== type)
        : [...sourceTypes, type]
    );
  };

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

      {/* Visibility selector intentionally hidden for now */}

      {!isReadonly && (
        <div className="ml-auto flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1">
                Context
                <ChevronDownIcon size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>Context</DropdownMenuLabel>
              <div className="px-2 pb-2 text-xs text-muted-foreground">
                Select the knowledge sources to use for this chat.
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={sourceTypes.includes("slack")}
                onCheckedChange={() => toggleSourceType("slack")}
              >
                Slack
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={sourceTypes.includes("docs")}
                onCheckedChange={() => toggleSourceType("docs")}
              >
                Docs
              </DropdownMenuCheckboxItem>
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
    prevProps.sourceTypes === nextProps.sourceTypes &&
    prevProps.ignoredDocIds === nextProps.ignoredDocIds
  );
});
