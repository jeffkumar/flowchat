"use client";

import { useState } from "react";
import useSWR from "swr";
import { Bot, Edit2, LoaderIcon, Lock, Plus, Trash2Icon } from "lucide-react";

import { fetcher } from "@/lib/utils";
import { useProjectSelector } from "@/hooks/use-project-selector";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

type Agent = {
  id: string;
  name: string;
  description: string;
  systemPrompt?: string;
  isBuiltIn: boolean;
  docId?: string;
};

export function AgentsViewer() {
  const { selectedProjectId } = useProjectSelector();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formSystemPrompt, setFormSystemPrompt] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const { data, isLoading, mutate } = useSWR<{ agents: Agent[] }>(
    selectedProjectId ? `/api/projects/${selectedProjectId}/agents` : null,
    fetcher
  );

  const openCreateDialog = () => {
    setFormName("");
    setFormDescription("");
    setFormSystemPrompt("");
    setEditingAgent(null);
    setIsCreateDialogOpen(true);
  };

  const openEditDialog = async (agent: Agent) => {
    if (agent.isBuiltIn) return;

    // Fetch full agent details including system prompt
    try {
      const response = await fetch(
        `/api/projects/${selectedProjectId}/agents/${agent.id}`
      );
      if (response.ok) {
        const { agent: fullAgent } = await response.json();
        setFormName(fullAgent.name);
        setFormDescription(fullAgent.description);
        setFormSystemPrompt(fullAgent.systemPrompt || "");
        setEditingAgent(fullAgent);
        setIsCreateDialogOpen(true);
      }
    } catch {
      toast.error("Failed to load agent details");
    }
  };

  const handleSave = async () => {
    if (!selectedProjectId || !formName.trim()) return;

    setIsSaving(true);
    try {
      const url = editingAgent
        ? `/api/projects/${selectedProjectId}/agents/${editingAgent.id}`
        : `/api/projects/${selectedProjectId}/agents`;

      const response = await fetch(url, {
        method: editingAgent ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formName.trim(),
          description: formDescription.trim(),
          systemPrompt: formSystemPrompt,
        }),
      });

      if (!response.ok) {
        const json = await response.json().catch(() => null);
        throw new Error(json?.error ?? "Failed to save agent");
      }

      toast.success(editingAgent ? "Agent updated" : "Agent created");
      setIsCreateDialogOpen(false);
      void mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save agent");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (agentId: string) => {
    if (!selectedProjectId) return;

    const deletePromise = fetch(
      `/api/projects/${selectedProjectId}/agents/${agentId}`,
      { method: "DELETE" }
    ).then(async (response) => {
      if (!response.ok) {
        const json = await response.json().catch(() => null);
        throw new Error(json?.error ?? "Failed to delete agent");
      }
    });

    toast.promise(deletePromise, {
      loading: "Deleting agent...",
      success: () => {
        void mutate();
        return "Agent deleted";
      },
      error: (error) =>
        error instanceof Error ? error.message : "Failed to delete agent",
    });
  };

  const agents = data?.agents ?? [];
  const builtInAgents = agents.filter((a) => a.isBuiltIn);
  const customAgents = agents.filter((a) => !a.isBuiltIn);

  return (
    <div className="space-y-6">
      {/* Built-in Agents */}
      <div className="rounded-2xl border border-border bg-background">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">Built-in Agents</h2>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <LoaderIcon className="animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-2 p-4">
            {builtInAgents.map((agent) => (
              <div
                key={agent.id}
                className="flex items-center justify-between rounded-lg border bg-card p-3 text-card-foreground shadow-sm"
              >
                <div className="flex items-center gap-3">
                  <Bot className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{agent.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {agent.description}
                    </span>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">Read-only</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Custom Agents */}
      <div className="rounded-2xl border border-border bg-background">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 className="text-sm font-medium">Custom Agents</h2>
          <Button
            size="sm"
            onClick={openCreateDialog}
            disabled={!selectedProjectId}
          >
            <Plus className="mr-1 h-4 w-4" />
            New Agent
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <LoaderIcon className="animate-spin text-muted-foreground" />
          </div>
        ) : customAgents.length === 0 ? (
          <div className="py-10 text-center text-muted-foreground">
            No custom agents. Create one to extend the project agent&apos;s capabilities.
          </div>
        ) : (
          <ScrollArea className="max-h-[40vh]">
            <div className="space-y-2 p-4">
              {customAgents.map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center justify-between rounded-lg border bg-card p-3 text-card-foreground shadow-sm"
                >
                  <div className="flex items-center gap-3">
                    <Bot className="h-5 w-5 shrink-0 text-primary" />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{agent.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {agent.description || "No description"}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => openEditDialog(agent)}
                      title="Edit agent"
                    >
                      <Edit2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => handleDelete(agent.id)}
                      title="Delete agent"
                    >
                      <Trash2Icon className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      <Dialog
        open={isCreateDialogOpen}
        onOpenChange={(open) => {
          setIsCreateDialogOpen(open);
          if (!open) {
            setEditingAgent(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingAgent ? "Edit Agent" : "Create New Agent"}
            </DialogTitle>
            <DialogDescription>
              {editingAgent
                ? "Update the agent's name, description, and system prompt."
                : "Create a custom agent with a specific system prompt. The project agent can invoke this agent when appropriate."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="agent-name">
                Name
              </label>
              <Input
                id="agent-name"
                placeholder="Agent name..."
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="agent-description">
                Description
              </label>
              <Input
                id="agent-description"
                placeholder="Brief description of what this agent does..."
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="agent-prompt">
                System Prompt
              </label>
              <Textarea
                id="agent-prompt"
                placeholder="Enter the system prompt for this agent..."
                value={formSystemPrompt}
                onChange={(e) => setFormSystemPrompt(e.target.value)}
                className="min-h-[200px] font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                This prompt defines the agent&apos;s behavior and personality.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsCreateDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={!formName.trim() || isSaving}
            >
              {isSaving ? "Saving..." : editingAgent ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
