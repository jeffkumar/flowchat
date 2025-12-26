import { put } from "@vercel/blob";
import type { Project } from "@/lib/db/schema";
import {
  createProjectDoc,
  getProjectDocByMicrosoftItemId,
  markProjectDocIndexError,
  markProjectDocIndexed,
  updateProjectDoc,
} from "@/lib/db/queries";
import { ingestUploadedDocToTurbopuffer } from "@/lib/ingest/docs";
import { deleteByFilterFromTurbopuffer } from "@/lib/rag/turbopuffer";
import { getMicrosoftAccessTokenForUser } from "@/lib/integrations/microsoft/graph";

type GraphItem = {
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
};

export type MicrosoftSyncResult =
  | { itemId: string; status: "synced"; docId: string; filename: string }
  | { itemId: string; status: "skipped"; reason: string }
  | { itemId: string; status: "failed"; error: string };

type InFlightLock = { startedAtMs: number };

const inFlightSyncLocks = new Map<string, InFlightLock>();
const IN_FLIGHT_LOCK_TTL_MS = 10 * 60 * 1000;

function isVercelBlobUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
}

function tryAcquireSyncLock(key: string) {
  const existing = inFlightSyncLocks.get(key);
  const now = Date.now();
  if (existing && now - existing.startedAtMs < IN_FLIGHT_LOCK_TTL_MS) {
    return false;
  }
  inFlightSyncLocks.set(key, { startedAtMs: now });
  return true;
}

function releaseSyncLock(key: string) {
  inFlightSyncLocks.delete(key);
}

function isSupportedMimeType(mimeType: string) {
  return (
    mimeType === "application/pdf" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}

function getDocsNamespace(isDefaultProject: boolean, projectId: string) {
  return isDefaultProject ? "_synergy_docsv2" : `_synergy_${projectId}_docsv2`;
}

export async function syncMicrosoftDriveItemsToProjectDocs({
  userId,
  project,
  driveId,
  items,
  token,
}: {
  userId: string;
  project: Project;
  driveId: string;
  items: Array<{ itemId: string; filename: string }>;
  token?: string;
}): Promise<MicrosoftSyncResult[]> {
  const accessToken = token ?? (await getMicrosoftAccessTokenForUser(userId));
  const namespace = getDocsNamespace(project.isDefault, project.id);

  return await Promise.all(
    items.map(async ({ itemId, filename }): Promise<MicrosoftSyncResult> => {
      const lockKey = `${project.id}:${driveId}:${itemId}`;
      const acquired = tryAcquireSyncLock(lockKey);
      if (!acquired) {
        return { itemId, status: "skipped", reason: "Already syncing" };
      }

      try {
        // 1. Fetch metadata
        const metaUrl = new URL(
          `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`
        );
        metaUrl.searchParams.set(
          "$select",
          "id,name,size,file,lastModifiedDateTime,webUrl"
        );

        const metaRes = await fetch(metaUrl.toString(), {
          headers: { authorization: `Bearer ${accessToken}` },
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
        const sizeBytes =
          typeof meta.size === "number" && Number.isFinite(meta.size)
            ? meta.size
            : null;
        const mimeType =
          meta.file && typeof meta.file.mimeType === "string"
            ? meta.file.mimeType
            : null;
        const lastModifiedDateTime = meta.lastModifiedDateTime;
        const sourceWebUrl = typeof meta.webUrl === "string" ? meta.webUrl : null;

        if (!mimeType || sizeBytes === null) {
          return {
            itemId,
            status: "failed",
            error: "Missing mimeType or size from Graph",
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

        // 2. Fetch content
        const contentUrl = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`;
        const contentRes = await fetch(contentUrl, {
          headers: { authorization: `Bearer ${accessToken}` },
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

        // 3. Upload to Blob Storage (optional)
        let blobUrl: string | null = null;
        try {
          const blob = await put(`${filename}`, arrayBuffer, {
            access: "public",
            contentType: mimeType,
          });
          blobUrl = blob.url;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Blob upload failed";
          console.error("Blob upload failed:", message);
        }

        // 4. Update or Create ProjectDoc
        let doc = await getProjectDocByMicrosoftItemId({
          projectId: project.id,
          itemId,
        });

        if (!blobUrl && (!doc || !isVercelBlobUrl(doc.blobUrl))) {
          return {
            itemId,
            status: "failed",
            error: "Blob upload failed; no stored blob copy available",
          };
        }

        const storedBlobUrl = blobUrl ?? doc?.blobUrl ?? null;

        if (doc) {
          doc = await updateProjectDoc({
            docId: doc.id,
            data: {
              blobUrl: storedBlobUrl ?? doc.blobUrl,
              sizeBytes,
              mimeType,
              filename,
              metadata: {
                ...((doc.metadata as object) || {}),
                driveId,
                itemId,
                lastModifiedDateTime,
                sourceWebUrl,
              },
            },
          });
        } else {
          doc = await createProjectDoc({
            projectId: project.id,
            createdBy: userId,
            organizationId: project.organizationId ?? null,
            // Microsoft-synced docs must have a stored blob copy so we can delete it later
            // without touching SharePoint/OneDrive.
            blobUrl: storedBlobUrl ?? "about:blank",
            filename,
            mimeType,
            sizeBytes,
            metadata: {
              driveId,
              itemId,
              lastModifiedDateTime,
              sourceWebUrl,
            },
          });
        }

        // 5. Ingest (Vectorize) synchronously
        const buffer = Buffer.from(arrayBuffer);
        try {
          await deleteByFilterFromTurbopuffer({
            namespace,
            filters: ["doc_id", "Eq", doc.id],
          });

          const result = await ingestUploadedDocToTurbopuffer({
            docId: doc.id,
            projectSlug: project.isDefault ? "default" : project.name,
            projectId: project.id,
            isDefaultProject: project.isDefault,
            createdBy: userId,
            organizationId: doc.organizationId,
            filename,
            category: doc.category,
            description: doc.description,
            mimeType,
            blobUrl: storedBlobUrl ?? doc.blobUrl,
            sourceUrl: sourceWebUrl ?? undefined,
            sourceCreatedAtMs: doc.createdAt.getTime(),
            fileBuffer: buffer,
          });

          await markProjectDocIndexed({
            docId: doc.id,
            indexedAt: new Date(),
            turbopufferNamespace: result.namespace,
          });

          await updateProjectDoc({
            docId: doc.id,
            data: {
              metadata: {
                ...((doc.metadata as object) || {}),
                driveId,
                itemId,
                lastModifiedDateTime,
                lastSyncedAt: new Date().toISOString(),
                sourceWebUrl,
              },
            },
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown ingestion error";
          await markProjectDocIndexError({ docId: doc.id, error: message });
          return { itemId, status: "failed", error: message };
        }

        return { itemId, status: "synced", docId: doc.id, filename };
      } catch (error) {
        const cause =
          error instanceof Error && typeof error.cause === "string"
            ? error.cause
            : null;
        return {
          itemId,
          status: "failed",
          error:
            cause ?? (error instanceof Error ? error.message : "Sync failed"),
        };
      } finally {
        releaseSyncLock(lockKey);
      }
    })
  );
}


