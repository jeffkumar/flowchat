import { del } from "@vercel/blob";
import { type NextRequest, NextResponse } from "next/server";

import { auth } from "@/app/(auth)/auth";
import {
  deleteProjectDocsByProjectId,
  getProjectByIdForUser,
  getProjectDocsByProjectId,
  markProjectDocDeleting,
} from "@/lib/db/queries";
import { deleteByFilterFromTurbopuffer } from "@/lib/rag/turbopuffer";
import { namespacesForSourceTypes } from "@/lib/rag/source-routing";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId } = await params;

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
    const { rowsDeleted } = await deleteByFilterFromTurbopuffer({
      namespace: docsNamespace,
      // Avoid `null` comparisons (Turbopuffer FiltersInput rejects them) and
      // ensure we only clear rows for this project (default namespaces are shared).
      filters: ["And", [["sourceType", "Eq", "docs"], ["project_id", "Eq", project.id]]],
    });
    turbopufferRowsDeleted = rowsDeleted;
  }

  const blobUrls = docs
    .map((d) => d.blobUrl)
    .filter((u): u is string => typeof u === "string" && u.length > 0);

  await Promise.all(blobUrls.map((url) => del(url)));

  const { deletedCount } = await deleteProjectDocsByProjectId({
    projectId: project.id,
  });

  return NextResponse.json(
    { deleted: true, deletedCount, turbopufferRowsDeleted },
    { status: 200 }
  );
}


