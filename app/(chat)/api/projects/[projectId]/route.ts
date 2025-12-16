import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import {
  deleteProjectById,
  getProjectByIdForUser,
  getProjectDocsByProjectId,
  markProjectDocDeleting,
} from "@/lib/db/queries";
import { del } from "@vercel/blob";
import { deleteByFilterFromTurbopuffer } from "@/lib/rag/turbopuffer";
import { namespacesForSourceTypes } from "@/lib/rag/source-routing";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await auth();
  const { projectId } = await params;

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const project = await getProjectByIdForUser({
      projectId,
      userId: session.user.id,
    });

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    if (project.isDefault) {
      return NextResponse.json(
        { error: "Cannot delete default project" },
        { status: 400 }
      );
    }

    // 1. Fetch all docs and mark them as deleting in DB
    const docs = await getProjectDocsByProjectId({ projectId: project.id });
    await Promise.all(
      docs.map((doc) => markProjectDocDeleting({ docId: doc.id }))
    );

    // 2. Delete Turbopuffer namespaces
    const namespaces = namespacesForSourceTypes(
      ["docs", "slack"],
      project.id,
      project.isDefault
    );

    await Promise.all(
      namespaces.map(async (namespace) => {
        if (!namespace) return;
        try {
          await deleteByFilterFromTurbopuffer({
            namespace,
            filters: ["doc_id", "Ne", null],
          });
        } catch (error) {
          console.warn(
            `Failed to delete namespace ${namespace} for project ${projectId}`,
            error
          );
        }
      })
    );

    // 3. Delete files from Vercel Blob
    const blobUrls = docs
      .map((d) => d.blobUrl)
      .filter((u): u is string => typeof u === "string" && u.length > 0);

    if (blobUrls.length > 0) {
      try {
        await Promise.all(blobUrls.map((url) => del(url)));
      } catch (error) {
        console.warn(
          `Failed to delete blobs for project ${projectId}`,
          error
        );
      }
    }

    // 4. Finally, delete project and its data from DB
    await deleteProjectById({ projectId, userId: session.user.id });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to delete project",
      },
      { status: 400 }
    );
  }
}
