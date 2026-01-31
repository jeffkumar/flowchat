import "server-only";

/**
 * Workflow Agents - Define custom document types with extraction configurations.
 *
 * Each workflow agent specifies:
 * - acceptedMimeTypes: Which file formats this agent can process
 * - extractionPrompt: Instructions for how to process/extract content from the document
 * - outputSchema: JSON schema defining the expected output structure (optional)
 */

// Supported MIME types for workflow agents
export const SUPPORTED_MIME_TYPES = [
  { value: "application/pdf", label: "PDF Documents" },
  {
    value: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Word Documents (.docx)",
  },
  { value: "text/markdown", label: "Markdown Files" },
  { value: "text/plain", label: "Plain Text Files" },
] as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number]["value"];

// Finance document types (special handling, not custom workflow agents)
export type FinanceDocumentType = "bank_statement" | "cc_statement" | "invoice";

export function isFinanceDocumentType(type: string): type is FinanceDocumentType {
  return ["bank_statement", "cc_statement", "invoice"].includes(type);
}

// Custom workflow agent stored in ProjectDoc
export type CustomWorkflowAgent = {
  id: string;
  name: string;
  description: string;
  acceptedMimeTypes: string[];
  extractionPrompt: string;
  outputSchema: Record<string, unknown> | null;
  docId: string;
};

export type WorkflowAgentExtractionConfig = {
  extractionPrompt: string;
  outputSchema: Record<string, unknown> | null;
  agentId: string | null;
  agentName: string | null;
};

// Default extraction prompt for general documents (when no workflow agent is selected)
export const DEFAULT_EXTRACTION_PROMPT = `Extract all text content from this document. Preserve the document structure including:
- Headings and sections
- Paragraphs and text blocks
- Tables (format as markdown tables)
- Lists (preserve bullet points and numbering)
- Important metadata (dates, names, references)

Output the content as clean, well-formatted markdown that preserves the original document's organization.`;

/**
 * Get the display label for a MIME type
 */
export function getMimeTypeLabel(mimeType: string): string {
  const found = SUPPORTED_MIME_TYPES.find((m) => m.value === mimeType);
  return found?.label ?? mimeType;
}

/**
 * Check if a MIME type is supported for workflow agents
 */
export function isSupportedMimeType(mimeType: string): boolean {
  return SUPPORTED_MIME_TYPES.some((m) => m.value === mimeType);
}

/**
 * Fetches the workflow agent configuration for a given agent ID.
 * Returns the agent's extraction config or default if not found.
 */
export async function getWorkflowAgentConfigById({
  agentId,
}: {
  agentId: string;
}): Promise<WorkflowAgentExtractionConfig> {
  const { getProjectDocById } = await import("@/lib/db/queries");

  try {
    const doc = await getProjectDocById({ docId: agentId });

    if (doc && doc.documentType === "workflow_agent") {
      const response = await fetch(doc.blobUrl);
      if (response.ok) {
        const config = await response.json();
        return {
          extractionPrompt: config.extractionPrompt || DEFAULT_EXTRACTION_PROMPT,
          outputSchema: config.outputSchema || null,
          agentId: doc.id,
          agentName: doc.description || doc.filename,
        };
      }
    }
  } catch {
    // Fall back to default if fetch fails
  }

  // Return default configuration
  return {
    extractionPrompt: DEFAULT_EXTRACTION_PROMPT,
    outputSchema: null,
    agentId: null,
    agentName: null,
  };
}

/**
 * Get all workflow agents for a project that accept a specific MIME type.
 */
export async function getWorkflowAgentsForMimeType({
  projectId,
  mimeType,
}: {
  projectId: string;
  mimeType: string;
}): Promise<CustomWorkflowAgent[]> {
  const { getProjectDocsByProjectId } = await import("@/lib/db/queries");

  const allDocs = await getProjectDocsByProjectId({ projectId });
  const workflowAgentDocs = allDocs.filter(
    (doc) => doc.documentType === "workflow_agent"
  );

  const matchingAgents: CustomWorkflowAgent[] = [];

  for (const doc of workflowAgentDocs) {
    try {
      const response = await fetch(doc.blobUrl);
      if (response.ok) {
        const config = await response.json();
        const acceptedMimeTypes: string[] = config.acceptedMimeTypes || [];

        if (acceptedMimeTypes.includes(mimeType)) {
          matchingAgents.push({
            id: doc.id,
            name: doc.description || doc.filename.replace(/\.json$/, ""),
            description: doc.category || "",
            acceptedMimeTypes,
            extractionPrompt: config.extractionPrompt || "",
            outputSchema: config.outputSchema || null,
            docId: doc.id,
          });
        }
      }
    } catch {
      // Skip agents that fail to load
    }
  }

  return matchingAgents;
}
