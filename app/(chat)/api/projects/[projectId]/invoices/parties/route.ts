import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { getInvoicePartiesByProjectId, getProjectByIdForUser } from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
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

    const parties = await getInvoicePartiesByProjectId({ projectId: project.id });
    return NextResponse.json(parties, { status: 200 });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    return new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to load invoice parties"
    ).toResponse();
  }
}


