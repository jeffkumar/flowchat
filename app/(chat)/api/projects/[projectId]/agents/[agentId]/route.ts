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
import { deleteByFilterFromTurbopuffer } from "@/lib/rag/turbopuffer";
import { namespacesForSourceTypes } from "@/lib/rag/source-routing";

const BUILT_IN_AGENT_IDS = ["project", "finance"];

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
  { params }: { params: Promise<{ projectId: string; agentId: string }> }
) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, agentId } = await params;

  // Check for built-in agents
  if (BUILT_IN_AGENT_IDS.includes(agentId)) {
    return NextResponse.json(
      {
        agent: {
          id: agentId,
          name: agentId === "project" ? "Project" : "Finance",
          description:
            agentId === "project"
              ? "Document Q&A, chat, and artifacts"
              : "Financial analysis and transaction queries",
          systemPrompt: "",
          isBuiltIn: true,
        },
      },
      { status: 200 }
    );
  }

  const project = await getProjectByIdForUser({
    projectId,
    userId: session.user.id,
  });

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const doc = await getProjectDocById({ docId: agentId });
  if (!doc || doc.projectId !== project.id || doc.documentType !== "agent") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Fetch the system prompt from blob storage
  let systemPrompt = "";
  try {
    const response = await fetch(doc.blobUrl);
    if (response.ok) {
      systemPrompt = await response.text();
    }
  } catch {
    // Content fetch failed, return empty
  }

  return NextResponse.json(
    {
      agent: {
        id: doc.id,
        name: doc.description || doc.filename.replace(/\.md$/, ""),
        description: doc.category || "",
        systemPrompt,
        isBuiltIn: false,
        docId: doc.id,
      },
    },
    { status: 200 }
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; agentId: string }> }
) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, agentId } = await params;

  // Cannot edit built-in agents
  if (BUILT_IN_AGENT_IDS.includes(agentId)) {
    return NextResponse.json(
      { error: "Cannot edit built-in agents" },
      { status: 403 }
    );
  }

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

  const doc = await getProjectDocById({ docId: agentId });
  if (!doc || doc.projectId !== project.id || doc.documentType !== "agent") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Only creator or admin can edit
  if (role === "member" && doc.createdBy !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { name, description, systemPrompt } = body as {
    name?: string;
    description?: string;
    systemPrompt?: string;
  };

  const newName = name?.trim() || doc.description || "Untitled Agent";
  const newDescription = description?.trim() ?? doc.category ?? "";
  const newSystemPrompt = systemPrompt ?? "";
  const filename = `${newName}.md`;

  // Delete old blob if it's a Vercel blob
  if (isVercelBlobUrl(doc.blobUrl)) {
    await del(doc.blobUrl);
  }

  // Upload new content
  const blob = await put(
    `agents/${projectId}/${Date.now()}-${filename}`,
    newSystemPrompt,
    {
      access: "public",
      contentType: "text/markdown",
    }
  );

  await updateProjectDoc({
    docId: agentId,
    data: {
      blobUrl: blob.url,
      filename,
      description: newName,
      category: newDescription,
      sizeBytes: new Blob([newSystemPrompt]).size,
    },
  });

  return NextResponse.json(
    {
      agent: {
        id: agentId,
        name: newName,
        description: newDescription,
        systemPrompt: newSystemPrompt,
        isBuiltIn: false,
        docId: agentId,
      },
    },
    { status: 200 }
  );
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; agentId: string }> }
) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, agentId } = await params;

  // Cannot delete built-in agents
  if (BUILT_IN_AGENT_IDS.includes(agentId)) {
    return NextResponse.json(
      { error: "Cannot delete built-in agents" },
      { status: 403 }
    );
  }

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

  const doc = await getProjectDocById({ docId: agentId });
  if (!doc || doc.projectId !== project.id || doc.documentType !== "agent") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (role === "member" && doc.createdBy !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await markProjectDocDeleting({ docId: doc.id });

  const [docsNamespace] = namespacesForSourceTypes(
    ["docs"],
    project.id,
    project.isDefault
  );

  if (docsNamespace) {
    await deleteByFilterFromTurbopuffer({
      namespace: docsNamespace,
      filters: ["doc_id", "Eq", doc.id],
    });
  }

  if (isVercelBlobUrl(doc.blobUrl)) {
    await del(doc.blobUrl);
  }

  await deleteProjectDocById({ docId: doc.id, userId: session.user.id });

  return NextResponse.json({ deleted: true }, { status: 200 });
}
