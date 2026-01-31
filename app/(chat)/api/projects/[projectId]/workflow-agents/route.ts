import { type NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { auth } from "@/app/(auth)/auth";
import {
  createProjectDoc,
  getProjectByIdForUser,
  getProjectDocsByProjectId,
} from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";
import {
  isSupportedMimeType,
  SUPPORTED_MIME_TYPES,
  type CustomWorkflowAgent,
} from "@/lib/ai/workflow-agents";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { projectId } = await params;
    const project = await getProjectByIdForUser({
      projectId,
      userId: session.user.id,
    });

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const allDocs = await getProjectDocsByProjectId({ projectId });
    const workflowAgentDocs = allDocs.filter(
      (doc) => doc.documentType === "workflow_agent"
    );

    // Fetch full agent configs from blob storage
    const customAgents: CustomWorkflowAgent[] = [];

    for (const doc of workflowAgentDocs) {
      try {
        const response = await fetch(doc.blobUrl);
        if (response.ok) {
          const config = await response.json();
          // Support both old format (schemaId as single fileType) and new format (acceptedMimeTypes array)
          let acceptedMimeTypes: string[] = config.acceptedMimeTypes || [];
          
          // Migration: if old format with schemaId, convert to new format
          if (acceptedMimeTypes.length === 0 && doc.schemaId) {
            const mimeTypeMap: Record<string, string> = {
              pdf: "application/pdf",
              docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              md: "text/markdown",
              txt: "text/plain",
            };
            const mappedMime = mimeTypeMap[doc.schemaId];
            if (mappedMime) {
              acceptedMimeTypes = [mappedMime];
            }
          }

          customAgents.push({
            id: doc.id,
            name: doc.description || doc.filename.replace(/\.json$/, ""),
            description: doc.category || "",
            acceptedMimeTypes,
            extractionPrompt: config.extractionPrompt || "",
            outputSchema: config.outputSchema || null,
            docId: doc.id,
          });
        }
      } catch {
        // Skip agents that fail to load
      }
    }

    return NextResponse.json(
      {
        agents: customAgents,
        supportedMimeTypes: SUPPORTED_MIME_TYPES,
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    return new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to load workflow agents"
    ).toResponse();
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { projectId } = await params;
    const project = await getProjectByIdForUser({
      projectId,
      userId: session.user.id,
    });

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const { name, description, acceptedMimeTypes, extractionPrompt, outputSchema } =
      body as {
        name?: string;
        description?: string;
        acceptedMimeTypes?: string[];
        extractionPrompt?: string;
        outputSchema?: Record<string, unknown> | null;
      };

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (!Array.isArray(acceptedMimeTypes) || acceptedMimeTypes.length === 0) {
      return NextResponse.json(
        { error: "At least one accepted file type is required" },
        { status: 400 }
      );
    }

    // Validate all MIME types are supported
    for (const mimeType of acceptedMimeTypes) {
      if (!isSupportedMimeType(mimeType)) {
        return NextResponse.json(
          { error: `Unsupported file type: ${mimeType}` },
          { status: 400 }
        );
      }
    }

    const agentConfig = JSON.stringify(
      {
        acceptedMimeTypes,
        extractionPrompt: extractionPrompt || "",
        outputSchema: outputSchema || null,
      },
      null,
      2
    );

    // Generate a filename based on the agent name
    const slugName = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .slice(0, 50);
    const filename = `${slugName}_workflow.json`;

    // Store workflow agent config in blob storage
    const blob = await put(
      `workflow-agents/${projectId}/${Date.now()}-${filename}`,
      agentConfig,
      {
        access: "public",
        contentType: "application/json",
      }
    );

    const doc = await createProjectDoc({
      projectId,
      createdBy: session.user.id,
      blobUrl: blob.url,
      filename,
      mimeType: "application/json",
      sizeBytes: new Blob([agentConfig]).size,
      documentType: "workflow_agent",
      description: name.trim(),
      category: description?.trim() || null,
      // Store a comma-separated list of MIME types in schemaId for querying
      schemaId: acceptedMimeTypes.join(","),
    });

    return NextResponse.json(
      {
        workflowAgent: {
          id: doc.id,
          name: name.trim(),
          description: description?.trim() || "",
          acceptedMimeTypes,
          extractionPrompt: extractionPrompt || "",
          outputSchema: outputSchema || null,
          docId: doc.id,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    return new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to create workflow agent"
    ).toResponse();
  }
}
