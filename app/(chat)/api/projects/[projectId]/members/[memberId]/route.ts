import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import {
  getProjectRole,
  getUserById,
  inviteUserToProject,
  removeProjectMember,
  revokeProjectInvitation,
} from "@/lib/db/queries";

const RoleBodySchema = z.object({
  role: z.enum(["admin", "member"]),
});

function parseMemberId(raw: string) {
  const decoded = decodeURIComponent(raw);
  const isEmail = decoded.includes("@");
  return { decoded, isEmail };
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ projectId: string; memberId: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, memberId } = await params;
  const role = await getProjectRole({ projectId, userId: session.user.id });
  if (!role) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const parsed = parseMemberId(memberId);
  
  // Allow users to remove themselves from a project (even if they're just a member)
  const isSelfRemoval = !parsed.isEmail && parsed.decoded === session.user.id;
  
  // Only admins/owners can remove others, but anyone can remove themselves
  if (role === "member" && !isSelfRemoval) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    if (parsed.isEmail) {
      await revokeProjectInvitation({
        projectId,
        email: parsed.decoded,
        revokedBy: session.user.id,
      });
    } else {
      await removeProjectMember({
        projectId,
        userId: parsed.decoded,
        removedBy: session.user.id,
      });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to remove member";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string; memberId: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, memberId } = await params;
  const role = await getProjectRole({ projectId, userId: session.user.id });
  if (!role) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (role === "member") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsedBody = RoleBodySchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const parsed = parseMemberId(memberId);

  try {
    if (parsed.isEmail) {
      const result = await inviteUserToProject({
        projectId,
        email: parsed.decoded,
        role: parsedBody.data.role,
        invitedBy: session.user.id,
      });
      return NextResponse.json({ result }, { status: 200 });
    }

    const user = await getUserById(parsed.decoded);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const result = await inviteUserToProject({
      projectId,
      email: user.email,
      role: parsedBody.data.role,
      invitedBy: session.user.id,
    });
    return NextResponse.json({ result }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update role";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


