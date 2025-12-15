import { NextResponse } from "next/server";

import { auth } from "@/app/(auth)/auth";
import {
  getProjectByIdForUser,
  getProjectDocsByProjectId,
} from "@/lib/db/queries";

export async function GET(
  _request: Request,
  { params }: { params: { projectId: string } }
) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const projectId = params.projectId;
  const project = await getProjectByIdForUser({
    projectId,
    userId: session.user.id,
  });

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const docs = await getProjectDocsByProjectId({ projectId });

  return NextResponse.json({ docs }, { status: 200 });
}


