"use client";

import { startTransition, useOptimistic, useState } from "react";
import { saveAgentModeAsCookie } from "@/app/(chat)/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentModes, type AgentMode } from "@/lib/ai/models";
import { cn } from "@/lib/utils";
import { CheckCircleFillIcon, ChevronDownIcon } from "./icons";
import { FolderOpen, TrendingUp } from "lucide-react";

function getAgentIcon(agentId: AgentMode) {
  switch (agentId) {
    case "finance":
      return <TrendingUp className="size-4" />;
    case "project":
    default:
      return <FolderOpen className="size-4" />;
  }
}

type AgentModeSelectorProps = {
  selectedAgentMode: AgentMode;
  onAgentModeChange?: (mode: AgentMode) => void;
  className?: string;
};

export function AgentModeSelector({
  selectedAgentMode,
  onAgentModeChange,
  className,
}: AgentModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const [optimisticMode, setOptimisticMode] = useOptimistic(selectedAgentMode);

  const selectedConfig = agentModes.find((m) => m.id === optimisticMode);

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <Button
          className={cn(
            "h-8 gap-1.5 px-2 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
            className
          )}
          variant="ghost"
        >
          {getAgentIcon(optimisticMode)}
          <span className="hidden text-xs font-medium sm:inline">
            {selectedConfig?.name ?? "Project"}
          </span>
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        {agentModes.map((mode) => (
          <DropdownMenuItem
            data-active={mode.id === optimisticMode}
            key={mode.id}
            onSelect={() => {
              setOpen(false);
              startTransition(() => {
                setOptimisticMode(mode.id);
                onAgentModeChange?.(mode.id);
                saveAgentModeAsCookie(mode.id);
              });
            }}
          >
            <button
              className="group/item flex w-full flex-row items-center justify-between gap-2"
              type="button"
            >
              <div className="flex items-center gap-2">
                {getAgentIcon(mode.id)}
                <div className="flex flex-col items-start gap-0.5">
                  <div className="text-sm">{mode.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {mode.description}
                  </div>
                </div>
              </div>
              <div className="shrink-0 text-foreground opacity-0 group-data-[active=true]/item:opacity-100">
                <CheckCircleFillIcon />
              </div>
            </button>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
