import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import {
  getProjectByIdForUser,
  getProjectDocsByProjectId,
} from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";
import type { CustomWorkflowAgent } from "@/lib/ai/workflow-agents";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { projectId } = await params;
    const { searchParams } = new URL(request.url);
    const mimeType = searchParams.get("mimeType");

    if (!mimeType) {
      return NextResponse.json(
        { error: "mimeType query parameter is required" },
        { status: 400 }
      );
    }

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

    // Find agents that accept this MIME type
    const matchingAgents: CustomWorkflowAgent[] = [];

    for (const doc of workflowAgentDocs) {
      try {
        const response = await fetch(doc.blobUrl);
        if (response.ok) {
          const config = await response.json();
          let acceptedMimeTypes: string[] = config.acceptedMimeTypes || [];

          // Migration: support old format with schemaId as single fileType
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

    return NextResponse.json(
      {
        agents: matchingAgents,
        mimeType,
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    return new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to get matching workflow agents"
    ).toResponse();
  }
}
