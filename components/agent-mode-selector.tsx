"use client";

import { startTransition, useOptimistic, useState } from "react";
import useSWR from "swr";
import { saveAgentModeAsCookie } from "@/app/(chat)/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentModes, type AgentMode } from "@/lib/ai/models";
import { cn, fetcher } from "@/lib/utils";
import { CheckCircleFillIcon, ChevronDownIcon } from "./icons";
import { Bot, FolderOpen, TrendingUp } from "lucide-react";
import { useProjectSelector } from "@/hooks/use-project-selector";

type CustomAgent = {
  id: string;
  name: string;
  description: string;
  isBuiltIn: boolean;
};

function getAgentIcon(agentId: string) {
  switch (agentId) {
    case "finance":
      return <TrendingUp className="size-4" />;
    case "project":
      return <FolderOpen className="size-4" />;
    default:
      return <Bot className="size-4" />;
  }
}

type AgentModeSelectorProps = {
  selectedAgentMode: AgentMode | string;
  onAgentModeChange?: (mode: AgentMode | string) => void;
  className?: string;
};

export function AgentModeSelector({
  selectedAgentMode,
  onAgentModeChange,
  className,
}: AgentModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const [optimisticMode, setOptimisticMode] = useOptimistic(selectedAgentMode);
  const { selectedProjectId } = useProjectSelector();

  const { data } = useSWR<{ agents: CustomAgent[] }>(
    selectedProjectId ? `/api/projects/${selectedProjectId}/agents` : null,
    fetcher
  );

  const allAgents = data?.agents ?? [];
  const builtInAgents = allAgents.filter((a) => a.isBuiltIn);
  const customAgents = allAgents.filter((a) => !a.isBuiltIn);

  // Find selected agent config
  const selectedBuiltIn = agentModes.find((m) => m.id === optimisticMode);
  const selectedCustom = customAgents.find((a) => a.id === optimisticMode);
  const selectedName = selectedBuiltIn?.name ?? selectedCustom?.name ?? "Project";

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
            {selectedName}
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

        {customAgents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1 text-xs text-muted-foreground">
              Custom Agents
            </div>
            {customAgents.map((agent) => (
              <DropdownMenuItem
                data-active={agent.id === optimisticMode}
                key={agent.id}
                onSelect={() => {
                  setOpen(false);
                  startTransition(() => {
                    setOptimisticMode(agent.id);
                    onAgentModeChange?.(agent.id);
                    // For custom agents, we don't save to cookie
                  });
                }}
              >
                <button
                  className="group/item flex w-full flex-row items-center justify-between gap-2"
                  type="button"
                >
                  <div className="flex items-center gap-2">
                    <Bot className="size-4 text-primary" />
                    <div className="flex flex-col items-start gap-0.5">
                      <div className="text-sm">{agent.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {agent.description || "Custom agent"}
                      </div>
                    </div>
                  </div>
                  <div className="shrink-0 text-foreground opacity-0 group-data-[active=true]/item:opacity-100">
                    <CheckCircleFillIcon />
                  </div>
                </button>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
