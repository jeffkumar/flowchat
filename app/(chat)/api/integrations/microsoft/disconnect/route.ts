import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import {
  getIntegrationConnectionForUser,
  revokeIntegrationConnection,
} from "@/lib/db/queries";

export async function DELETE() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const connection = await getIntegrationConnectionForUser({
    userId: session.user.id,
    provider: "microsoft",
  });

  if (!connection || connection.revokedAt) {
    return NextResponse.json({ error: "Not connected" }, { status: 400 });
  }

  await revokeIntegrationConnection({ connectionId: connection.id });

  return NextResponse.json({ success: true }, { status: 200 });
}


