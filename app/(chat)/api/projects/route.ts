import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import {
  createProject,
  getOrCreateDefaultProjectForUser,
  getProjectsByUserId,
} from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

export async function GET() {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Ensure the default project exists so callers can rely on it.
    await getOrCreateDefaultProjectForUser({ userId: session.user.id });
    const projects = await getProjectsByUserId(session.user.id);

    return NextResponse.json({ projects }, { status: 200 });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    return new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to load projects"
    ).toResponse();
  }
}

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch (_error) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid project name" },
      { status: 400 }
    );
  }

  const project = await createProject({
    name: parsed.data.name,
    createdBy: session.user.id,
  });

  return NextResponse.json({ project }, { status: 201 });
}
