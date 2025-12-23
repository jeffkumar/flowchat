import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { getIntegrationConnectionForUser } from "@/lib/db/queries";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const connection = await getIntegrationConnectionForUser({
    userId: session.user.id,
    provider: "microsoft",
  });

  if (!connection || connection.revokedAt) {
    return NextResponse.json({ connected: false }, { status: 200 });
  }

  return NextResponse.json(
    {
      connected: true,
      accountEmail: connection.accountEmail,
      tenantId: connection.tenantId,
      scopes: connection.scopes,
      expiresAt: connection.expiresAt?.toISOString() ?? null,
    },
    { status: 200 }
  );
}


