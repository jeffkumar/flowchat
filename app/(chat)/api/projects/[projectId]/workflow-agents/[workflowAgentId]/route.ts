import { del, put } from "@vercel/blob";
import { type NextRequest, NextResponse } from "next/server";

import { auth } from "@/app/(auth)/auth";
import {
  deleteProjectDocById,
  getProjectByIdForUser,
  getProjectDocById,
  getProjectRole,
  markProjectDocDeleting,
  updateProjectDoc,
} from "@/lib/db/queries";
import { isSupportedMimeType } from "@/lib/ai/workflow-agents";

function isVercelBlobUrl(value: string) {
  try {
    const url = new URL(value);
    return url.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
}

export async function GET(
  _request: NextRequest,
  {
    params,
  }: { params: Promise<{ projectId: string; workflowAgentId: string }> }
) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, workflowAgentId } = await params;

  const project = await getProjectByIdForUser({
    projectId,
    userId: session.user.id,
  });

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const doc = await getProjectDocById({ docId: workflowAgentId });
  if (
    !doc ||
    doc.projectId !== project.id ||
    doc.documentType !== "workflow_agent"
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Fetch the workflow agent config from blob storage
  let extractionPrompt = "";
  let outputSchema: Record<string, unknown> | null = null;
  let acceptedMimeTypes: string[] = [];

  try {
    const response = await fetch(doc.blobUrl);
    if (response.ok) {
      const config = await response.json();
      extractionPrompt = config.extractionPrompt || "";
      outputSchema = config.outputSchema || null;
      acceptedMimeTypes = config.acceptedMimeTypes || [];

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
    }
  } catch {
    // Content fetch failed, return empty
  }

  return NextResponse.json(
    {
      workflowAgent: {
        id: doc.id,
        name: doc.description || doc.filename.replace(/\.json$/, ""),
        description: doc.category || "",
        acceptedMimeTypes,
        extractionPrompt,
        outputSchema,
        docId: doc.id,
      },
    },
    { status: 200 }
  );
}

export async function PUT(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ projectId: string; workflowAgentId: string }> }
) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, workflowAgentId } = await params;

  const role = await getProjectRole({ projectId, userId: session.user.id });
  if (!role) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const project = await getProjectByIdForUser({
    projectId,
    userId: session.user.id,
  });

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const doc = await getProjectDocById({ docId: workflowAgentId });
  if (
    !doc ||
    doc.projectId !== project.id ||
    doc.documentType !== "workflow_agent"
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Only creator or admin can edit
  if (role === "member" && doc.createdBy !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

  // Validate MIME types if provided
  if (acceptedMimeTypes !== undefined) {
    if (!Array.isArray(acceptedMimeTypes) || acceptedMimeTypes.length === 0) {
      return NextResponse.json(
        { error: "At least one accepted file type is required" },
        { status: 400 }
      );
    }
    for (const mimeType of acceptedMimeTypes) {
      if (!isSupportedMimeType(mimeType)) {
        return NextResponse.json(
          { error: `Unsupported file type: ${mimeType}` },
          { status: 400 }
        );
      }
    }
  }

  // Fetch existing config to merge with updates
  let existingConfig: Record<string, unknown> = {};
  try {
    const response = await fetch(doc.blobUrl);
    if (response.ok) {
      existingConfig = await response.json();
    }
  } catch {
    // Start fresh if fetch fails
  }

  const newName = name?.trim() || doc.description || "Untitled Workflow Agent";
  const newDescription = description?.trim() ?? doc.category ?? "";
  const newAcceptedMimeTypes =
    acceptedMimeTypes ?? (existingConfig.acceptedMimeTypes as string[]) ?? [];

  // Generate a filename based on the agent name
  const slugName = newName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 50);
  const filename = `${slugName}_workflow.json`;

  // Build the new config
  const agentConfig = JSON.stringify(
    {
      acceptedMimeTypes: newAcceptedMimeTypes,
      extractionPrompt: extractionPrompt ?? existingConfig.extractionPrompt ?? "",
      outputSchema: outputSchema ?? existingConfig.outputSchema ?? null,
    },
    null,
    2
  );

  // Delete old blob if it's a Vercel blob
  if (isVercelBlobUrl(doc.blobUrl)) {
    await del(doc.blobUrl);
  }

  // Upload new content
  const blob = await put(
    `workflow-agents/${projectId}/${Date.now()}-${filename}`,
    agentConfig,
    {
      access: "public",
      contentType: "application/json",
    }
  );

  await updateProjectDoc({
    docId: workflowAgentId,
    data: {
      blobUrl: blob.url,
      filename,
      description: newName,
      category: newDescription,
      sizeBytes: new Blob([agentConfig]).size,
      schemaId: newAcceptedMimeTypes.join(","),
    },
  });

  return NextResponse.json(
    {
      workflowAgent: {
        id: workflowAgentId,
        name: newName,
        description: newDescription,
        acceptedMimeTypes: newAcceptedMimeTypes,
        extractionPrompt: extractionPrompt ?? existingConfig.extractionPrompt ?? "",
        outputSchema: outputSchema ?? existingConfig.outputSchema ?? null,
        docId: workflowAgentId,
      },
    },
    { status: 200 }
  );
}

export async function DELETE(
  _request: NextRequest,
  {
    params,
  }: { params: Promise<{ projectId: string; workflowAgentId: string }> }
) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, workflowAgentId } = await params;

  const role = await getProjectRole({ projectId, userId: session.user.id });
  if (!role) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const project = await getProjectByIdForUser({
    projectId,
    userId: session.user.id,
  });

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const doc = await getProjectDocById({ docId: workflowAgentId });
  if (
    !doc ||
    doc.projectId !== project.id ||
    doc.documentType !== "workflow_agent"
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (role === "member" && doc.createdBy !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await markProjectDocDeleting({ docId: doc.id });

  if (isVercelBlobUrl(doc.blobUrl)) {
    await del(doc.blobUrl);
  }

  await deleteProjectDocById({ docId: doc.id, userId: session.user.id });

  return NextResponse.json({ deleted: true }, { status: 200 });
}
