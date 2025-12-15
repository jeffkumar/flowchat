import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { after } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import {
  createProjectDoc,
  getProjectByIdForUser,
  getOrCreateDefaultProjectForUser,
  markProjectDocIndexError,
  markProjectDocIndexed,
} from "@/lib/db/queries";
import { ingestUploadedDocToTurbopuffer } from "@/lib/ingest/docs";

// Use Blob instead of File since File is not available in Node.js environment
const FileSchema = z.object({
  file: z
    .instanceof(Blob)
    .refine((file) => file.size <= 20 * 1024 * 1024, {
      message: "File size should be less than 20MB",
    })
    // Update the file type based on the kind of files you want to accept
    .refine(
      (file) =>
        [
          "image/jpeg",
          "image/png",
          "application/pdf",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ].includes(file.type),
      {
        message: "File type should be JPEG, PNG, PDF, or DOCX",
      }
    ),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (request.body === null) {
    return new Response("Request body is empty", { status: 400 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as Blob;
    const providedProjectId = formData.get("projectId");

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const validatedFile = FileSchema.safeParse({ file });

    if (!validatedFile.success) {
      const errorMessage = validatedFile.error.errors
        .map((error) => error.message)
        .join(", ");

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    // Get filename from formData since Blob doesn't have name property
    const filename = (formData.get("file") as File).name;
    const fileBuffer = await file.arrayBuffer();

    try {
      const data = await put(`${filename}`, fileBuffer, {
        access: "public",
        contentType: file.type,
      });

      let projectId: string;
      let projectSlug: string;

      if (typeof providedProjectId === "string" && providedProjectId.length > 0) {
        const project = await getProjectByIdForUser({
          projectId: providedProjectId,
          userId: session.user.id,
        });
        if (!project) {
          return NextResponse.json({ error: "Project not found" }, { status: 404 });
        }
        projectId = project.id;
        projectSlug = project.isDefault ? "default" : project.name;
      } else {
        const defaultProject = await getOrCreateDefaultProjectForUser({
          userId: session.user.id,
        });
        projectId = defaultProject.id;
        projectSlug = "default";
      }

      const doc = await createProjectDoc({
        projectId,
        createdBy: session.user.id,
        blobUrl: data.url,
        filename,
        mimeType: file.type,
        sizeBytes: file.size,
      });

      const shouldIngest =
        file.type === "application/pdf" ||
        file.type ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

      if (shouldIngest) {
        const buffer = Buffer.from(fileBuffer);
        after(async () => {
          try {
            const result = await ingestUploadedDocToTurbopuffer({
              docId: doc.id,
              projectSlug,
              projectId,
              createdBy: session.user.id,
              organizationId: doc.organizationId,
              filename,
              mimeType: file.type,
              blobUrl: data.url,
              fileBuffer: buffer,
            });

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
      }

      return NextResponse.json({ ...data, doc }, { status: 200 });
    } catch (_error) {
      return NextResponse.json({ error: "Upload failed" }, { status: 500 });
    }
  } catch (_error) {
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 }
    );
  }
}
