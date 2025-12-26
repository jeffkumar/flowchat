import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { getProjectByIdForUser } from "@/lib/db/queries";
import { getMicrosoftAccessTokenForUser } from "@/lib/integrations/microsoft/graph";
import {
  syncMicrosoftDriveItemsToProjectDocs,
  type MicrosoftSyncResult,
} from "@/lib/integrations/microsoft/sync-microsoft-docs";

const BodySchema = z.object({
  driveId: z.string().min(1),
  folderId: z.string().min(1),
  dryRun: z.boolean().optional(),
  documentType: z
    .enum(["general_doc", "bank_statement", "cc_statement", "invoice"])
    .optional(),
});

type GraphChild = {
  id?: string;
  name?: string;
  folder?: object;
  file?: object;
};

const SUPPORTED_FILE_EXTENSIONS = new Set(["pdf", "doc", "docx"]);

function isSupportedMicrosoftFileName(name: string | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === trimmed.length - 1) return false;
  const ext = trimmed.slice(lastDot + 1).toLowerCase();
  return SUPPORTED_FILE_EXTENSIONS.has(ext);
}

function chunk<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

async function listFolderChildrenRecursive({
  driveId,
  folderId,
  token,
  maxFiles,
}: {
  driveId: string;
  folderId: string;
  token: string;
  maxFiles: number;
}) {
  const pendingFolders: string[] = [folderId];
  const files: Array<{ itemId: string; filename: string }> = [];

  while (pendingFolders.length > 0 && files.length < maxFiles) {
    const currentFolderId = pendingFolders.pop();
    if (!currentFolderId) break;

    let nextUrl: string | null = new URL(
      `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(currentFolderId)}/children`
    ).toString();

    const urlObj = new URL(nextUrl);
    urlObj.searchParams.set("$top", "200");
    urlObj.searchParams.set("$select", "id,name,folder,file");
    nextUrl = urlObj.toString();

    while (nextUrl && files.length < maxFiles) {
      const res = await fetch(nextUrl, {
        headers: { authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || "Failed to list folder children");
      }

      const data = (await res.json()) as {
        value?: GraphChild[];
        "@odata.nextLink"?: string;
      };

      const children = Array.isArray(data.value) ? data.value : [];
      for (const child of children) {
        if (files.length >= maxFiles) break;
        if (!child?.id || !child?.name) continue;
        if (child.folder) {
          pendingFolders.push(child.id);
        } else if (child.file) {
          if (isSupportedMicrosoftFileName(child.name)) {
            files.push({ itemId: child.id, filename: child.name });
          }
        }
      }

      nextUrl = typeof data["@odata.nextLink"] === "string" ? data["@odata.nextLink"] : null;
    }
  }

  return files;
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
  const files = await listFolderChildrenRecursive({
    driveId: parsed.data.driveId,
    folderId: parsed.data.folderId,
    token,
    maxFiles: 2000,
  });

  if (parsed.data.dryRun) {
    return NextResponse.json(
      {
        totalFiles: files.length,
      },
      { status: 200 }
    );
  }

  const batches = chunk(files, 50);
  const allResults: MicrosoftSyncResult[] = [];
  for (const batch of batches) {
    const results = await syncMicrosoftDriveItemsToProjectDocs({
      userId: session.user.id,
      project,
      driveId: parsed.data.driveId,
      items: batch,
      token,
      documentType: parsed.data.documentType,
    });
    allResults.push(...results);
  }

  const synced = allResults.filter((r) => r.status === "synced").length;
  const skipped = allResults.filter((r) => r.status === "skipped").length;
  const failed = allResults.filter((r) => r.status === "failed").length;

  return NextResponse.json(
    {
      totalFiles: files.length,
      synced,
      skipped,
      failed,
      results: allResults,
    },
    { status: 200 }
  );
}


