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
import {
  createEmbedding,
  deleteByFilterFromTurbopuffer,
  upsertRowsToTurbopuffer,
  type TurbopufferUpsertRow,
} from "@/lib/rag/turbopuffer";
import { namespacesForSourceTypes } from "@/lib/rag/source-routing";
import crypto from "node:crypto";

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
  { params }: { params: Promise<{ projectId: string; noteId: string }> }
) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, noteId } = await params;

  const project = await getProjectByIdForUser({
    projectId,
    userId: session.user.id,
  });

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const doc = await getProjectDocById({ docId: noteId });
  if (!doc || doc.projectId !== project.id || doc.documentType !== "note") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Fetch the content from blob storage
  let content = "";
  try {
    const response = await fetch(doc.blobUrl);
    if (response.ok) {
      content = await response.text();
    }
  } catch {
    // Content fetch failed, return empty
  }

  return NextResponse.json(
    {
      note: {
        ...doc,
        content,
      },
    },
    { status: 200 }
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; noteId: string }> }
) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, noteId } = await params;

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

  const doc = await getProjectDocById({ docId: noteId });
  if (!doc || doc.projectId !== project.id || doc.documentType !== "note") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Only creator or admin can edit
  if (role === "member" && doc.createdBy !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { title, content } = body as { title?: string; content?: string };

  const newTitle = title?.trim() || doc.description || "Untitled";
  const newContent = content ?? "";
  const filename = `${newTitle}.md`;

  // Delete old blob if it's a Vercel blob
  if (isVercelBlobUrl(doc.blobUrl)) {
    await del(doc.blobUrl);
  }

  // Upload new content
  const blob = await put(
    `notes/${projectId}/${Date.now()}-${filename}`,
    newContent,
    {
      access: "public",
      contentType: "text/markdown",
    }
  );

  await updateProjectDoc({
    docId: noteId,
    data: {
      blobUrl: blob.url,
      filename,
      description: newTitle,
      sizeBytes: new Blob([newContent]).size,
    },
  });

  // Re-index in Turbopuffer: delete old vectors, insert new ones
  const [docsNamespace] = namespacesForSourceTypes(
    ["docs"],
    project.id,
    project.isDefault
  );

  if (docsNamespace && newContent.trim()) {
    // Delete existing vectors for this doc
    await deleteByFilterFromTurbopuffer({
      namespace: docsNamespace,
      filters: ["doc_id", "Eq", noteId],
    });

    // Chunk the content and create embeddings
    const chunks = chunkText(newContent.trim());
    const indexedAtMs = Date.now();
    const contentHash = crypto.createHash("sha1").update(newContent).digest("hex");
    const rows: TurbopufferUpsertRow[] = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const metadataPrefix = `filename: ${filename}\ndescription: ${newTitle}\n\n`;
      const vector = await createEmbedding(`${metadataPrefix}${chunk}`);

      const idHash = crypto
        .createHash("sha256")
        .update(`${noteId}:${contentHash}:${index}`)
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
        doc_id: noteId,
        project_id: projectId,
        created_by: session.user.id,
        organization_id: null,
        filename,
        doc_category: null,
        doc_description: newTitle,
        mime_type: "text/markdown",
        blob_url: blob.url,
        document_type: "note",
        chunk_index: index,
      });
    }

    if (rows.length > 0) {
      await upsertRowsToTurbopuffer({ namespace: docsNamespace, rows });
    }

    // Update indexedAt timestamp
    await updateProjectDoc({
      docId: noteId,
      data: { indexedAt: new Date() },
    });
  }

  const updatedDoc = await getProjectDocById({ docId: noteId });

  return NextResponse.json(
    {
      note: {
        ...updatedDoc,
        content: newContent,
      },
    },
    { status: 200 }
  );
}

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

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; noteId: string }> }
) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, noteId } = await params;

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

  const doc = await getProjectDocById({ docId: noteId });
  if (!doc || doc.projectId !== project.id || doc.documentType !== "note") {
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
