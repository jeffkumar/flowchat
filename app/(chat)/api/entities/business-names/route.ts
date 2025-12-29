import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { getBusinessEntityNamesForUser } from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const names = await getBusinessEntityNamesForUser({ userId: session.user.id });
    return NextResponse.json({ names }, { status: 200 });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    return new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to load business entity names"
    ).toResponse();
  }
}


