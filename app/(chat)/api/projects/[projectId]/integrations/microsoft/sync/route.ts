import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import {
  getProjectByIdForUser,
  getProjectDocsByProjectId,
  getProjectRole,
} from "@/lib/db/queries";
import { syncMicrosoftDriveItemsToProjectDocs } from "@/lib/integrations/microsoft/sync-microsoft-docs";

const BodySchema = z.object({
  driveId: z.string().min(1),
  items: z.array(
    z.object({
      itemId: z.string().min(1),
      filename: z.string().min(1),
    })
  ).min(1).max(50),
  documentType: z
    .enum(["general_doc", "bank_statement", "cc_statement", "invoice"])
    .optional(),
  invoiceSender: z.string().trim().min(1).max(500).optional(),
  invoiceRecipient: z.string().trim().min(1).max(500).optional(),
});

export async function GET(
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

  try {
    const docs = await getProjectDocsByProjectId({ projectId });
    
    // Filter for docs that have Microsoft metadata
    const syncedDocs = docs
      .filter((doc) => {
        const meta = doc.metadata as Record<string, unknown> | null;
        return meta && typeof meta.driveId === "string" && typeof meta.itemId === "string";
      })
      .map((doc) => {
        const meta = doc.metadata as Record<string, unknown>;
        const sourceWebUrl = typeof meta.sourceWebUrl === "string" ? meta.sourceWebUrl : null;
        const url = sourceWebUrl ?? doc.blobUrl ?? null;
        return {
          docId: doc.id,
          filename: doc.filename,
          url,
          documentType: doc.documentType,
          parseStatus: doc.parseStatus,
          itemId: meta.itemId as string,
          driveId: meta.driveId as string,
          lastSyncedAt: (meta.lastSyncedAt as string) || doc.createdAt.toISOString(),
          lastModifiedDateTime: meta.lastModifiedDateTime as string | undefined,
        };
      });

    return NextResponse.json({ docs: syncedDocs }, { status: 200 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list synced docs";
    const cause =
      error instanceof Error && typeof error.cause === "string" ? error.cause : null;
    console.error("Microsoft sync list error:", message, cause ? `cause: ${cause}` : "");
    // Don’t break the UI if DB reads fail; return empty list with a warning.
    return NextResponse.json({ docs: [], warning: cause ?? message }, { status: 200 });
  }
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

  const results = await syncMicrosoftDriveItemsToProjectDocs({
    userId: session.user.id,
    project,
    driveId: parsed.data.driveId,
    items: parsed.data.items,
    documentType: parsed.data.documentType,
    invoiceSender: parsed.data.invoiceSender,
    invoiceRecipient: parsed.data.invoiceRecipient,
  });

  return NextResponse.json({ results }, { status: 200 });
}

