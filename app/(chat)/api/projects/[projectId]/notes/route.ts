import crypto from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { auth } from "@/app/(auth)/auth";
import {
  createProjectDoc,
  getProjectByIdForUser,
  getProjectDocsByProjectId,
  updateProjectDoc,
} from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";
import {
  createEmbedding,
  upsertRowsToTurbopuffer,
  type TurbopufferUpsertRow,
} from "@/lib/rag/turbopuffer";
import { namespacesForSourceTypes } from "@/lib/rag/source-routing";

// Simple text chunker for notes
function chunkText(text: string, maxLen = 2400, overlap = 200): string[] {
  const chunks: string[] = [];
  const n = text.length;
  if (n === 0 || maxLen <= 0) {
    return chunks;
  }
  const effectiveOverlap = Math.max(0, Math.min(overlap, maxLen - 1));
  const step = maxLen - effectiveOverlap;
  let i = 0;
  while (i < n) {
    const end = Math.min(i + maxLen, n);
    const slice = text.slice(i, end).trim();
    if (slice) chunks.push(slice);
    if (end === n) break;
    i += step;
  }
  return chunks;
}

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
    const notes = allDocs.filter((doc) => doc.documentType === "note");

    return NextResponse.json({ notes }, { status: 200 });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    return new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to load notes"
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
    const { title, content } = body as { title?: string; content?: string };

    if (!title || typeof title !== "string" || title.trim().length === 0) {
      return NextResponse.json(
        { error: "Title is required" },
        { status: 400 }
      );
    }

    // Vercel Blob requires non-empty body, use a space if content is empty
    const noteContent = content || " ";
    const filename = `${title.trim()}.md`;

    // Store content in blob storage
    const blob = await put(
      `notes/${projectId}/${Date.now()}-${filename}`,
      noteContent,
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
      sizeBytes: new Blob([noteContent]).size,
      documentType: "note",
      description: title.trim(),
    });

    // Index note content to Turbopuffer if there's actual content
    const contentToIndex = noteContent.trim();
    if (contentToIndex.length > 1) {
      const [docsNamespace] = namespacesForSourceTypes(
        ["docs"],
        project.id,
        project.isDefault
      );

      if (docsNamespace) {
        const chunks = chunkText(contentToIndex);
        const indexedAtMs = Date.now();
        const contentHash = crypto.createHash("sha1").update(contentToIndex).digest("hex");
        const rows: TurbopufferUpsertRow[] = [];

        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          const metadataPrefix = `filename: ${filename}\ndescription: ${title.trim()}\n\n`;
          const vector = await createEmbedding(`${metadataPrefix}${chunk}`);

          const idHash = crypto
            .createHash("sha256")
            .update(`${doc.id}:${contentHash}:${index}`)
            .digest("hex")
            .slice(0, 40);
          const rowId = `docs_${idHash}`;

          rows.push({
            id: rowId,
            vector,
            content: chunk.length > 3800 ? `${chunk.slice(0, 3800)}…` : chunk,
            sourceType: "docs",
            doc_source: "note",
            source_url: null,
            sourceCreatedAtMs: doc.createdAt.getTime(),
            indexedAtMs,
            doc_id: doc.id,
            project_id: projectId,
            created_by: session.user.id,
            organization_id: null,
            filename,
            doc_category: null,
            doc_description: title.trim(),
            mime_type: "text/markdown",
            blob_url: blob.url,
            document_type: "note",
            chunk_index: index,
          });
        }

        if (rows.length > 0) {
          await upsertRowsToTurbopuffer({ namespace: docsNamespace, rows });
          await updateProjectDoc({
            docId: doc.id,
            data: { indexedAt: new Date() },
          });
        }
      }
    }

    return NextResponse.json({ note: doc }, { status: 201 });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    return new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to create note"
    ).toResponse();
  }
}
