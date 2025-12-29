import { del } from "@vercel/blob";
import { type NextRequest, NextResponse } from "next/server";

import { auth } from "@/app/(auth)/auth";
import {
  deleteProjectDocsByProjectId,
  getProjectByIdForUser,
  getProjectDocsByProjectId,
  getProjectRole,
  markProjectDocDeleting,
} from "@/lib/db/queries";
import { deleteByFilterFromTurbopuffer } from "@/lib/rag/turbopuffer";
import { namespacesForSourceTypes } from "@/lib/rag/source-routing";

function isVercelBlobUrl(value: string) {
  try {
    const url = new URL(value);
    return url.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId } = await params;

  const role = await getProjectRole({ projectId, userId: session.user.id });
  if (!role) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (role === "member") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const project = await getProjectByIdForUser({
    projectId,
    userId: session.user.id,
  });

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const docs = await getProjectDocsByProjectId({ projectId: project.id });

  await Promise.all(docs.map((doc) => markProjectDocDeleting({ docId: doc.id })));

  const [docsNamespace] = namespacesForSourceTypes(
    ["docs"],
    project.id,
    project.isDefault
  );

  let turbopufferRowsDeleted = 0;
  if (docsNamespace) {
    const deleteFilters = project.isDefault
      ? // Default namespace is shared across projects, so scope deletion to this project only.
        ["And", [["sourceType", "Eq", "docs"], ["project_id", "Eq", project.id]]]
      : // Project-specific namespace: safe to delete everything in the docs namespace.
        ["sourceType", "Eq", "docs"];

    const { rowsDeleted } = await deleteByFilterFromTurbopuffer({
      namespace: docsNamespace,
      filters: deleteFilters,
    });
    turbopufferRowsDeleted = rowsDeleted;
  }

  const blobUrls = docs
    .map((d) => d.blobUrl)
    .filter((u): u is string => typeof u === "string" && u.length > 0)
    .filter((u) => isVercelBlobUrl(u));

  await Promise.all(blobUrls.map((url) => del(url)));

  const { deletedCount } = await deleteProjectDocsByProjectId({
    projectId: project.id,
  });

  return NextResponse.json(
    { deleted: true, deletedCount, turbopufferRowsDeleted },
    { status: 200 }
  );
}


