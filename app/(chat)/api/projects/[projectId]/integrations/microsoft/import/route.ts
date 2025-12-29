import { put } from "@vercel/blob";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import {
  isDevelopmentEnvironment,
  preventDuplicateProjectDocFilenames,
} from "@/lib/constants";
import {
  createProjectDoc,
  getProjectByIdForUser,
  getProjectDocById,
  getProjectDocByProjectIdAndFilename,
  getProjectRole,
  markProjectDocIndexError,
  markProjectDocIndexed,
} from "@/lib/db/queries";
import { ingestUploadedDocToTurbopuffer } from "@/lib/ingest/docs";
import { deleteByFilterFromTurbopuffer } from "@/lib/rag/turbopuffer";
import { getMicrosoftAccessTokenForUser } from "@/lib/integrations/microsoft/graph";

const BodySchema = z.object({
  driveId: z.string().min(1),
  itemIds: z.array(z.string().min(1)).min(1).max(10),
  category: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().min(1).max(600).optional(),
});

type GraphItem = {
  id?: string;
  name?: string;
  size?: number;
  webUrl?: string;
  file?: { mimeType?: string };
};

type ImportResult =
  | { itemId: string; status: "imported"; docId: string; filename: string }
  | { itemId: string; status: "skipped"; reason: string }
  | { itemId: string; status: "failed"; error: string };

function isSupportedMimeType(mimeType: string) {
  return (
    mimeType === "application/pdf" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "text/csv" ||
    mimeType === "application/csv" ||
    mimeType === "application/vnd.ms-excel"
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId } = await params;
  const role = await getProjectRole({ projectId, userId: session.user.id });
  if (!role) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (role === "member") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const project = await getProjectByIdForUser({
    projectId,
    userId: session.user.id,
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const token = await getMicrosoftAccessTokenForUser(session.user.id);

  const results = await Promise.all(
    parsed.data.itemIds.map(async (itemId): Promise<ImportResult> => {
      try {
        const metaUrl = new URL(
          `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(parsed.data.driveId)}/items/${encodeURIComponent(itemId)}`
        );
        metaUrl.searchParams.set("$select", "id,name,size,file,webUrl");

        const metaRes = await fetch(metaUrl.toString(), {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!metaRes.ok) {
          const text = await metaRes.text().catch(() => "");
          return {
            itemId,
            status: "failed",
            error: text || "Failed to fetch item metadata",
          };
        }

        const meta = (await metaRes.json()) as GraphItem;
        const filename = typeof meta.name === "string" ? meta.name : null;
        const sizeBytes =
          typeof meta.size === "number" && Number.isFinite(meta.size)
            ? meta.size
            : null;
        const mimeType =
          meta.file && typeof meta.file.mimeType === "string"
            ? meta.file.mimeType
            : null;
        const sourceWebUrl = typeof meta.webUrl === "string" ? meta.webUrl : null;

        if (!filename || !mimeType || sizeBytes === null) {
          return {
            itemId,
            status: "failed",
            error: "Missing filename/mimeType/size from Graph",
          };
        }

        if (sizeBytes > 40 * 1024 * 1024) {
          return {
            itemId,
            status: "skipped",
            reason: "File too large (max 40MB)",
          };
        }

        if (!isSupportedMimeType(mimeType)) {
          return {
            itemId,
            status: "skipped",
            reason: `Unsupported mimeType: ${mimeType}`,
          };
        }

        if (preventDuplicateProjectDocFilenames) {
          const existing = await getProjectDocByProjectIdAndFilename({
            projectId: project.id,
            filename,
          });
          if (existing) {
            return {
              itemId,
              status: "skipped",
              reason: "Already imported (same filename in this project)",
            };
          }
        }

        const contentUrl = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(parsed.data.driveId)}/items/${encodeURIComponent(itemId)}/content`;
        const contentRes = await fetch(contentUrl, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!contentRes.ok) {
          const text = await contentRes.text().catch(() => "");
          return {
            itemId,
            status: "failed",
            error: text || "Failed to download content",
          };
        }

        const arrayBuffer = await contentRes.arrayBuffer();
        const blob = await put(`${filename}`, arrayBuffer, {
          access: "public",
          contentType: mimeType,
        });

        const doc = await createProjectDoc({
          projectId: project.id,
          createdBy: session.user.id,
          organizationId: project.organizationId ?? null,
          blobUrl: blob.url,
          filename,
          category: parsed.data.category ?? null,
          description: parsed.data.description ?? null,
          mimeType,
          sizeBytes,
          metadata: {
            driveId: parsed.data.driveId,
            itemId,
            sourceWebUrl,
          },
        });

        const buffer = Buffer.from(arrayBuffer);
        after(async () => {
          try {
            const latestBefore = await getProjectDocById({ docId: doc.id });
            if (!latestBefore || latestBefore.indexingError === "Deleting") {
              return;
            }

            const result = await ingestUploadedDocToTurbopuffer({
              docId: doc.id,
              projectSlug: project.isDefault ? "default" : project.name,
              projectId: project.id,
              isDefaultProject: project.isDefault,
              createdBy: session.user.id,
              organizationId: doc.organizationId,
              filename,
              category: doc.category,
              description: doc.description,
              mimeType,
              blobUrl: blob.url,
              sourceUrl: sourceWebUrl,
              sourceCreatedAtMs: doc.createdAt.getTime(),
              fileBuffer: buffer,
            });

            const latestAfter = await getProjectDocById({ docId: doc.id });
            if (!latestAfter || latestAfter.indexingError === "Deleting") {
              await deleteByFilterFromTurbopuffer({
                namespace: result.namespace,
                filters: ["doc_id", "Eq", doc.id],
              });
              return;
            }

            await markProjectDocIndexed({
              docId: doc.id,
              indexedAt: new Date(),
              turbopufferNamespace: result.namespace,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Unknown ingestion error";
            await markProjectDocIndexError({ docId: doc.id, error: message });
          }
        });

        return { itemId, status: "imported", docId: doc.id, filename };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Import failed";
        return { itemId, status: "failed", error: message };
      }
    })
  );

  return NextResponse.json({ results }, { status: 200 });
}


