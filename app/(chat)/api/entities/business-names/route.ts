import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { getBusinessEntityNamesForUser } from "@/lib/db/queries";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const names = await getBusinessEntityNamesForUser({ userId: session.user.id });
  return NextResponse.json({ names }, { status: 200 });
}


