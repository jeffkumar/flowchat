"use client";
import { useRouter } from "next/navigation";
import { memo } from "react";
import { useWindowSize } from "usehooks-ts";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { PlusIcon } from "./icons";
import { useSidebar } from "./ui/sidebar";
import type { VisibilityType } from "./visibility-selector";

const ALL_SOURCE_TYPES: Array<"slack" | "docs"> = ["slack", "docs"];
const DOCS_ONLY: Array<"slack" | "docs"> = ["docs"];
const SLACK_ONLY: Array<"slack" | "docs"> = ["slack"];

function PureChatHeader({
  chatId,
  selectedVisibilityType,
  isReadonly,
  sourceTypes,
  setSourceTypes,
}: {
  chatId: string;
  selectedVisibilityType: VisibilityType;
  isReadonly: boolean;
  sourceTypes: Array<"slack" | "docs">;
  setSourceTypes: (next: Array<"slack" | "docs">) => void;
}) {
  const router = useRouter();
  const { open } = useSidebar();

  const { width: windowWidth } = useWindowSize();

  const mode =
    sourceTypes.includes("slack") && sourceTypes.includes("docs")
      ? "all"
      : sourceTypes.includes("docs")
        ? "docs"
        : "slack";

  return (
    <header className="sticky top-0 flex items-center gap-2 bg-background px-2 py-1.5 md:px-2">
      <SidebarToggle />

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
          <Button
            aria-pressed={mode === "all"}
            onClick={() => setSourceTypes(ALL_SOURCE_TYPES)}
            size="sm"
            type="button"
            variant={mode === "all" ? "secondary" : "outline"}
          >
            All
          </Button>
          <Button
            aria-pressed={mode === "docs"}
            onClick={() => setSourceTypes(DOCS_ONLY)}
            size="sm"
            type="button"
            variant={mode === "docs" ? "secondary" : "outline"}
          >
            Docs
          </Button>
          <Button
            aria-pressed={mode === "slack"}
            onClick={() => setSourceTypes(SLACK_ONLY)}
            size="sm"
            type="button"
            variant={mode === "slack" ? "secondary" : "outline"}
          >
            Slack
          </Button>
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
    prevProps.sourceTypes === nextProps.sourceTypes
  );
});
