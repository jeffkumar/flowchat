import { type NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { auth } from "@/app/(auth)/auth";
import {
  createProjectDoc,
  getProjectByIdForUser,
  getProjectDocsByProjectId,
} from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";

// Built-in agents that cannot be deleted
const BUILT_IN_AGENTS = [
  {
    id: "project",
    name: "Project",
    description: "Document Q&A, chat, and artifacts",
    systemPrompt: "", // Uses default system prompt
    isBuiltIn: true,
  },
  {
    id: "finance",
    name: "Finance",
    description: "Financial analysis and transaction queries",
    systemPrompt: "", // Uses default finance system prompt
    isBuiltIn: true,
  },
];

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
    const customAgents = allDocs
      .filter((doc) => doc.documentType === "agent")
      .map((doc) => ({
        id: doc.id,
        name: doc.description || doc.filename.replace(/\.md$/, ""),
        description: doc.category || "",
        isBuiltIn: false,
        docId: doc.id,
      }));

    // Combine built-in agents with custom agents
    const agents = [...BUILT_IN_AGENTS, ...customAgents];

    return NextResponse.json({ agents }, { status: 200 });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    return new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to load agents"
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
    const { name, description, systemPrompt } = body as {
      name?: string;
      description?: string;
      systemPrompt?: string;
    };

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }

    const agentContent = systemPrompt || "";
    const filename = `${name.trim()}.md`;

    // Store system prompt in blob storage
    const blob = await put(
      `agents/${projectId}/${Date.now()}-${filename}`,
      agentContent,
      {
        access: "public",
        contentType: "text/markdown",
      }
    );

    const doc = await createProjectDoc({
      projectId,
      createdBy: session.user.id,
      blobUrl: blob.url,
      filename,
      mimeType: "text/markdown",
      sizeBytes: new Blob([agentContent]).size,
      documentType: "agent",
      description: name.trim(),
      category: description?.trim() || null,
    });

    return NextResponse.json(
      {
        agent: {
          id: doc.id,
          name: name.trim(),
          description: description?.trim() || "",
          isBuiltIn: false,
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
      error instanceof Error ? error.message : "Failed to create agent"
    ).toResponse();
  }
}
