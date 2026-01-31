"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  CircleDollarSign,
  Edit2,
  FileText,
  LoaderIcon,
  Lock,
  Plus,
  Sparkles,
  Trash2Icon,
} from "lucide-react";

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

type SupportedMimeType = {
  value: string;
  label: string;
};

type CustomWorkflowAgent = {
  id: string;
  name: string;
  description: string;
  acceptedMimeTypes: string[];
  extractionPrompt: string;
  outputSchema: Record<string, unknown> | null;
  docId: string;
};

type WorkflowAgentsResponse = {
  agents: CustomWorkflowAgent[];
  supportedMimeTypes: SupportedMimeType[];
};

// Built-in finance workflow agents (read-only, handled by Reducto)
const BUILT_IN_FINANCE_AGENTS = [
  {
    id: "bank_statement",
    name: "Bank Statements",
    description: "Extract transactions from bank statements with date, description, amount, and category",
  },
  {
    id: "cc_statement",
    name: "Credit Card Statements",
    description: "Extract transactions from credit card statements with merchant normalization",
  },
  {
    id: "invoice",
    name: "Invoices",
    description: "Extract invoice header information and line items",
  },
];

function getMimeTypeLabel(
  mimeType: string,
  supportedTypes: SupportedMimeType[]
): string {
  return (
    supportedTypes.find((m) => m.value === mimeType)?.label ||
    mimeType.split("/").pop() ||
    mimeType
  );
}

type SchemaValidationResult = {
  isValid: boolean;
  isEmpty: boolean;
  error: string | null;
};

function validateJsonSchema(schemaString: string): SchemaValidationResult {
  if (!schemaString.trim()) {
    return { isValid: true, isEmpty: true, error: null };
  }

  try {
    const parsed = JSON.parse(schemaString);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { isValid: false, isEmpty: false, error: "Schema must be a JSON object" };
    }

    if (parsed.type !== "object") {
      return { isValid: false, isEmpty: false, error: 'Root schema must have type: "object"' };
    }

    if (!parsed.properties || typeof parsed.properties !== "object") {
      return { isValid: false, isEmpty: false, error: "Schema must have a 'properties' object" };
    }

    if (Object.keys(parsed.properties).length === 0) {
      return { isValid: false, isEmpty: false, error: "Schema must have at least one property" };
    }

    for (const [key, value] of Object.entries(parsed.properties)) {
      if (typeof value !== "object" || value === null) {
        return { isValid: false, isEmpty: false, error: `Property '${key}' must be an object` };
      }
      const prop = value as Record<string, unknown>;
      if (!prop.type) {
        return { isValid: false, isEmpty: false, error: `Property '${key}' must have a 'type'` };
      }
    }

    return { isValid: true, isEmpty: false, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Invalid JSON";
    return { isValid: false, isEmpty: false, error: message };
  }
}

export function WorkflowAgentsViewer() {
  const { selectedProjectId } = useProjectSelector();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<CustomWorkflowAgent | null>(null);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formAcceptedMimeTypes, setFormAcceptedMimeTypes] = useState<string[]>([]);
  const [formExtractionPrompt, setFormExtractionPrompt] = useState("");
  const [formOutputSchema, setFormOutputSchema] = useState("");
  const [formSchemaDescription, setFormSchemaDescription] = useState("");
  const [isGeneratingSchema, setIsGeneratingSchema] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const schemaValidation = useMemo(
    () => validateJsonSchema(formOutputSchema),
    [formOutputSchema]
  );

  const { data, isLoading, mutate } = useSWR<WorkflowAgentsResponse>(
    selectedProjectId ? `/api/projects/${selectedProjectId}/workflow-agents` : null,
    fetcher
  );

  const supportedMimeTypes = data?.supportedMimeTypes ?? [];
  const agents = data?.agents ?? [];

  const openCreateDialog = () => {
    setFormName("");
    setFormDescription("");
    setFormAcceptedMimeTypes([]);
    setFormExtractionPrompt("");
    setFormOutputSchema("");
    setFormSchemaDescription("");
    setEditingAgent(null);
    setIsDialogOpen(true);
  };

  const openEditDialog = async (agent: CustomWorkflowAgent) => {
    try {
      const response = await fetch(
        `/api/projects/${selectedProjectId}/workflow-agents/${agent.id}`
      );
      if (response.ok) {
        const { workflowAgent: fullAgent } = await response.json();
        setFormName(fullAgent.name);
        setFormDescription(fullAgent.description);
        setFormAcceptedMimeTypes(fullAgent.acceptedMimeTypes || []);
        setFormExtractionPrompt(fullAgent.extractionPrompt || "");
        setFormOutputSchema(
          fullAgent.outputSchema
            ? JSON.stringify(fullAgent.outputSchema, null, 2)
            : ""
        );
        setFormSchemaDescription("");
        setEditingAgent(fullAgent);
        setIsDialogOpen(true);
      }
    } catch {
      toast.error("Failed to load workflow agent details");
    }
  };

  const toggleMimeType = (mimeType: string) => {
    setFormAcceptedMimeTypes((prev) =>
      prev.includes(mimeType)
        ? prev.filter((m) => m !== mimeType)
        : [...prev, mimeType]
    );
  };

  const handleSave = async () => {
    if (
      !selectedProjectId ||
      !formName.trim() ||
      formAcceptedMimeTypes.length === 0
    )
      return;

    if (!schemaValidation.isValid) {
      toast.error(schemaValidation.error || "Invalid output schema");
      return;
    }

    let parsedSchema: Record<string, unknown> | null = null;
    if (formOutputSchema.trim()) {
      parsedSchema = JSON.parse(formOutputSchema) as Record<string, unknown>;
    }

    setIsSaving(true);
    try {
      const url = editingAgent
        ? `/api/projects/${selectedProjectId}/workflow-agents/${editingAgent.id}`
        : `/api/projects/${selectedProjectId}/workflow-agents`;

      const response = await fetch(url, {
        method: editingAgent ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formName.trim(),
          description: formDescription.trim(),
          acceptedMimeTypes: formAcceptedMimeTypes,
          extractionPrompt: formExtractionPrompt,
          outputSchema: parsedSchema,
        }),
      });

      if (!response.ok) {
        const json = await response.json().catch(() => null);
        throw new Error(json?.error ?? "Failed to save workflow agent");
      }

      toast.success(
        editingAgent ? "Workflow agent updated" : "Workflow agent created"
      );
      setIsDialogOpen(false);
      void mutate();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save workflow agent"
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleGenerateSchema = async () => {
    if (!formSchemaDescription.trim()) {
      toast.error("Please enter a description of the output schema");
      return;
    }

    setIsGeneratingSchema(true);
    try {
      const response = await fetch("/api/generate-schema", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: formSchemaDescription.trim(),
          projectId: selectedProjectId,
        }),
      });

      if (!response.ok) {
        const json = await response.json().catch(() => null);
        throw new Error(json?.error ?? "Failed to generate schema");
      }

      const { schema } = await response.json();
      setFormOutputSchema(JSON.stringify(schema, null, 2));
      toast.success("Schema generated! Review and edit if needed.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to generate schema"
      );
    } finally {
      setIsGeneratingSchema(false);
    }
  };

  const handleDelete = async (agentId: string) => {
    if (!selectedProjectId) return;

    const deletePromise = fetch(
      `/api/projects/${selectedProjectId}/workflow-agents/${agentId}`,
      { method: "DELETE" }
    ).then(async (response) => {
      if (!response.ok) {
        const json = await response.json().catch(() => null);
        throw new Error(json?.error ?? "Failed to delete workflow agent");
      }
    });

    toast.promise(deletePromise, {
      loading: "Deleting workflow agent...",
      success: () => {
        void mutate();
        return "Workflow agent deleted";
      },
      error: (error) =>
        error instanceof Error ? error.message : "Failed to delete workflow agent",
    });
  };

  return (
    <div className="space-y-6">
      {/* Built-in Finance Workflow Agents (Read-only) */}
      <div className="rounded-2xl border border-border bg-background">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex items-center gap-2">
            <CircleDollarSign className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">Finance Workflow Agents</h2>
            <Lock className="h-3 w-3 text-muted-foreground" />
          </div>
        </div>

        <div className="space-y-2 p-4">
          {BUILT_IN_FINANCE_AGENTS.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center justify-between rounded-lg border bg-card p-3 text-card-foreground shadow-sm"
            >
              <div className="flex items-center gap-3">
                <CircleDollarSign className="h-5 w-5 shrink-0 text-muted-foreground" />
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{agent.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {agent.description}
                  </span>
                </div>
              </div>
              <span className="text-xs text-muted-foreground">Built-in</span>
            </div>
          ))}
        </div>
      </div>

      {/* Custom Workflow Agents */}
      <div className="rounded-2xl border border-border bg-background">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">Custom Workflow Agents</h2>
          </div>
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
        ) : agents.length === 0 ? (
          <div className="py-10 text-center text-muted-foreground">
            No workflow agents yet. Create one to define custom document extraction.
          </div>
        ) : (
          <ScrollArea className="max-h-[50vh]">
            <div className="space-y-2 p-4">
              {agents.map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center justify-between rounded-lg border bg-card p-3 text-card-foreground shadow-sm"
                >
                  <div className="flex items-center gap-3">
                    <FileText className="h-5 w-5 shrink-0 text-primary" />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{agent.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {agent.description ||
                          agent.acceptedMimeTypes
                            .map((m) => getMimeTypeLabel(m, supportedMimeTypes))
                            .join(", ")}
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

      {/* Create/Edit Dialog */}
      <Dialog
        open={isDialogOpen}
        onOpenChange={(open) => {
          setIsDialogOpen(open);
          if (!open) {
            setEditingAgent(null);
          }
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingAgent ? "Edit Workflow Agent" : "Create Workflow Agent"}
            </DialogTitle>
            <DialogDescription>
              {editingAgent
                ? "Update the workflow agent configuration."
                : "Create a workflow agent to define how specific document types are extracted and processed."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="workflow-name">
                Document Type Name
              </label>
              <Input
                id="workflow-name"
                placeholder="e.g., Purchase Orders, Contracts, Receipts..."
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                This name will appear as a document type option when uploading files.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="workflow-description">
                Description
              </label>
              <Input
                id="workflow-description"
                placeholder="Brief description of what documents this agent processes..."
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Accepted File Types</label>
              <div className="grid grid-cols-2 gap-2">
                {supportedMimeTypes.map((mimeType) => {
                  const isSelected = formAcceptedMimeTypes.includes(mimeType.value);
                  return (
                    <button
                      key={mimeType.value}
                      type="button"
                      onClick={() => toggleMimeType(mimeType.value)}
                      className={`flex items-center gap-2 rounded-md border p-2 text-left transition-colors ${
                        isSelected
                          ? "border-primary bg-primary/10"
                          : "hover:bg-muted/50"
                      }`}
                    >
                      <div
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-muted-foreground"
                        }`}
                      >
                        {isSelected && <Check className="h-3 w-3" />}
                      </div>
                      <span className="text-sm">{mimeType.label}</span>
                    </button>
                  );
                })}
              </div>
              {formAcceptedMimeTypes.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Select at least one file type this agent will process.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="workflow-prompt">
                Extraction Prompt
              </label>
              <Textarea
                id="workflow-prompt"
                placeholder="Instructions for how to extract and format content from these documents..."
                value={formExtractionPrompt}
                onChange={(e) => setFormExtractionPrompt(e.target.value)}
                className="min-h-[150px] font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Instructions that guide the extraction process.
              </p>
            </div>

            <div className="space-y-3">
              <label className="text-sm font-medium" htmlFor="workflow-schema">
                Output Schema (optional)
              </label>

              {/* AI Schema Generation */}
              <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Sparkles className="h-4 w-4 text-primary" />
                  Generate Schema with AI
                </div>
                <Textarea
                  id="schema-description"
                  placeholder="Describe what data you want to extract, e.g., 'Extract PO number, vendor, line items with SKU, quantity, and price'"
                  value={formSchemaDescription}
                  onChange={(e) => setFormSchemaDescription(e.target.value)}
                  className="min-h-[80px] text-sm"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={handleGenerateSchema}
                  disabled={!formSchemaDescription.trim() || isGeneratingSchema}
                >
                  {isGeneratingSchema ? (
                    <>
                      <LoaderIcon className="mr-1 h-4 w-4 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-1 h-4 w-4" />
                      Generate Schema
                    </>
                  )}
                </Button>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {formOutputSchema
                    ? "Edit generated schema or write your own:"
                    : "Or write your own JSON schema:"}
                </span>
                {!schemaValidation.isEmpty && (
                  <div className="flex items-center gap-1.5">
                    {schemaValidation.isValid ? (
                      <>
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                        <span className="text-xs text-green-600">Valid schema</span>
                      </>
                    ) : (
                      <>
                        <AlertCircle className="h-4 w-4 text-red-500" />
                        <span className="text-xs text-red-600">Invalid</span>
                      </>
                    )}
                  </div>
                )}
              </div>
              <Textarea
                id="workflow-schema"
                placeholder='{"type": "object", "properties": {...}}'
                value={formOutputSchema}
                onChange={(e) => setFormOutputSchema(e.target.value)}
                className={`min-h-[150px] font-mono text-sm ${
                  !schemaValidation.isEmpty && !schemaValidation.isValid
                    ? "border-red-500 focus-visible:ring-red-500"
                    : ""
                }`}
              />
              {schemaValidation.error ? (
                <p className="text-xs text-red-600">{schemaValidation.error}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  JSON schema defining the expected output structure. Leave empty for
                  unstructured text extraction.
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={
                !formName.trim() ||
                formAcceptedMimeTypes.length === 0 ||
                isSaving ||
                !schemaValidation.isValid
              }
            >
              {isSaving ? "Saving..." : editingAgent ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
