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
  getProjectDocById,
  getProjectDocByProjectIdAndFilename,
  getOrCreateDefaultProjectForUser,
  getProjectByIdForUser,
  markProjectDocIndexError,
  markProjectDocIndexed,
  upsertInvoiceForDocument,
  updateProjectDoc,
} from "@/lib/db/queries";
import {
  ingestDocSummaryToTurbopuffer,
  ingestUploadedDocToTurbopuffer,
} from "@/lib/ingest/docs";
import { parseStructuredProjectDoc } from "@/lib/ingest/parse-structured-document";
import { deleteByFilterFromTurbopuffer } from "@/lib/rag/turbopuffer";

// Use Blob instead of File since File is not available in Node.js environment
const FileSchema = z.object({
  file: z
    .instanceof(Blob)
    .refine((file) => file.size <= 40 * 1024 * 1024, {
      message: "File size should be less than 40MB",
    })
    // Update the file type based on the kind of files you want to accept
    .refine(
      (file) =>
        [
          "image/jpeg",
          "image/png",
          "application/pdf",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "text/csv",
          "application/csv",
        ].includes(file.type),
      {
        message: "File type should be JPEG, PNG, PDF, DOCX, or CSV",
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
    const rawCategory = formData.get("category");
    const rawDescription = formData.get("description");
    const rawDocumentType = formData.get("documentType");
    const rawInvoiceSender = formData.get("invoiceSender");
    const rawInvoiceRecipient = formData.get("invoiceRecipient");

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
    const category =
      typeof rawCategory === "string" && rawCategory.trim().length > 0
        ? rawCategory.trim().slice(0, 120)
        : null;
    const description =
      typeof rawDescription === "string" && rawDescription.trim().length > 0
        ? rawDescription.trim().slice(0, 600)
        : null;

    const documentType =
      rawDocumentType === "general_doc" ||
      rawDocumentType === "bank_statement" ||
      rawDocumentType === "cc_statement" ||
      rawDocumentType === "invoice"
        ? rawDocumentType
        : "general_doc";

    const invoiceSender =
      typeof rawInvoiceSender === "string" && rawInvoiceSender.trim().length > 0
        ? rawInvoiceSender.trim().slice(0, 500)
        : undefined;
    const invoiceRecipient =
      typeof rawInvoiceRecipient === "string" &&
      rawInvoiceRecipient.trim().length > 0
        ? rawInvoiceRecipient.trim().slice(0, 500)
        : undefined;

    if (
      (file.type === "text/csv" || file.type === "application/csv") &&
      documentType === "general_doc"
    ) {
      return NextResponse.json(
        { error: "CSV uploads must use a structured document type (bank/cc/invoice)." },
        { status: 400 }
      );
    }

    try {
      let projectId: string;
      let projectSlug: string;
      let isDefaultProject = false;

      if (
        typeof providedProjectId === "string" &&
        providedProjectId.length > 0
      ) {
        const project = await getProjectByIdForUser({
          projectId: providedProjectId,
          userId: session.user.id,
        });
        if (!project) {
          return NextResponse.json(
            { error: "Project not found" },
            { status: 404 }
          );
        }
        projectId = project.id;
        projectSlug = project.isDefault ? "default" : project.name;
        isDefaultProject = project.isDefault;
      } else {
        const defaultProject = await getOrCreateDefaultProjectForUser({
          userId: session.user.id,
        });
        projectId = defaultProject.id;
        projectSlug = "default";
        isDefaultProject = true;
      }

      if (preventDuplicateProjectDocFilenames) {
        const existing = await getProjectDocByProjectIdAndFilename({
          projectId,
          filename,
        });
        if (existing) {
          return NextResponse.json(
            {
              error:
                "This file has already been uploaded to this project with the same name.",
            },
            { status: 409 }
          );
        }
      }

      const fileBuffer = await file.arrayBuffer();
      const data = await put(`${filename}`, fileBuffer, {
        access: "public",
        contentType: file.type,
      });

      const doc = await createProjectDoc({
        projectId,
        createdBy: session.user.id,
        blobUrl: data.url,
        filename,
        category,
        description,
        mimeType: file.type,
        sizeBytes: file.size,
        documentType,
        parseStatus: documentType === "general_doc" ? "pending" : "pending",
      });

      if (documentType === "invoice" && (invoiceSender || invoiceRecipient)) {
        await upsertInvoiceForDocument({
          documentId: doc.id,
          data: {
            sender: invoiceSender,
            recipient: invoiceRecipient,
          },
        });
      }

      const shouldIngest =
        documentType === "general_doc" &&
        (file.type === "application/pdf" ||
          file.type ===
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

      if (shouldIngest) {
        const buffer = Buffer.from(fileBuffer);
        after(async () => {
          console.log("ProjectDoc ingestion started", {
            docId: doc.id,
            projectId,
            projectSlug,
            filename,
            mimeType: file.type,
          });
          try {
            const latestBefore = await getProjectDocById({ docId: doc.id });
            if (!latestBefore || latestBefore.indexingError === "Deleting") {
              console.log("ProjectDoc ingestion skipped (deleted/deleting)", {
                docId: doc.id,
              });
              return;
            }

            const result = await ingestUploadedDocToTurbopuffer({
              docId: doc.id,
              projectSlug,
              projectId,
              isDefaultProject,
              createdBy: session.user.id,
              organizationId: doc.organizationId,
              filename,
              category: doc.category,
              description: doc.description,
              documentType,
              mimeType: file.type,
              blobUrl: data.url,
              sourceUrl: null,
              sourceCreatedAtMs: doc.createdAt.getTime(),
              fileBuffer: buffer,
            });

            const latestAfter = await getProjectDocById({ docId: doc.id });
            if (!latestAfter || latestAfter.indexingError === "Deleting") {
              await deleteByFilterFromTurbopuffer({
                namespace: result.namespace,
                filters: ["doc_id", "Eq", doc.id],
              });
              console.log("ProjectDoc ingestion cleanup (deleted mid-ingest)", {
                docId: doc.id,
              });
              return;
            }

            await markProjectDocIndexed({
              docId: doc.id,
              indexedAt: new Date(),
              turbopufferNamespace: result.namespace,
            });
            await updateProjectDoc({
              docId: doc.id,
              data: {
                parseStatus: "parsed",
              },
            });
            console.log("ProjectDoc ingestion succeeded", {
              docId: doc.id,
              namespace: result.namespace,
              chunks: result.chunks,
            });
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "Unknown ingestion error";
            await markProjectDocIndexError({ docId: doc.id, error: message });
            console.warn("ProjectDoc ingestion failed", {
              docId: doc.id,
              error: message,
            });
          }
        });
      }
      if (documentType !== "general_doc") {
        after(async () => {
          try {
            const latestBefore = await getProjectDocById({ docId: doc.id });
            if (!latestBefore || latestBefore.indexingError === "Deleting") {
              return;
            }

            const summaryTextParts = [
              `Document type: ${documentType}`,
              filename ? `Filename: ${filename}` : "",
              category ? `Category: ${category}` : "",
              description ? `Description: ${description}` : "",
            ].filter((p) => p.length > 0);

            const summaryText = summaryTextParts.join("\n");
            const result = await ingestDocSummaryToTurbopuffer({
              docId: doc.id,
              projectId,
              isDefaultProject,
              createdBy: session.user.id,
              organizationId: doc.organizationId,
              filename,
              mimeType: file.type,
              blobUrl: data.url,
              sourceUrl: null,
              sourceCreatedAtMs: doc.createdAt.getTime(),
              documentType,
              summaryText,
            });

            await markProjectDocIndexed({
              docId: doc.id,
              indexedAt: new Date(),
              turbopufferNamespace: result.namespace,
            });

            const parseResult = await parseStructuredProjectDoc({
              docId: doc.id,
              userId: session.user.id,
              ingestSummaryToTurbopuffer: false,
            });
            if (!parseResult.ok) {
              console.warn("Structured doc parse failed", {
                docId: doc.id,
                error: parseResult.error,
              });
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Unknown summary indexing error";
            await markProjectDocIndexError({ docId: doc.id, error: message });
          }
        });
      }

      return NextResponse.json({ ...data, doc }, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      if (isDevelopmentEnvironment) {
        return NextResponse.json({ error: message }, { status: 500 });
      }
      return NextResponse.json({ error: "Upload failed" }, { status: 500 });
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to process request";
    if (isDevelopmentEnvironment) {
      return NextResponse.json({ error: message }, { status: 500 });
    }
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 }
    );
  }
}
