import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { isAdminSession } from "@/lib/admin";
import {
  getAllWaitlistRequests,
  approveWaitlistRequest,
  rejectWaitlistRequest,
} from "@/lib/db/queries";

export async function GET() {
  const session = await auth();
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const requests = await getAllWaitlistRequests();
    return NextResponse.json({ requests });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to fetch waitlist requests",
        message:
          error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!isAdminSession(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!session.user?.id) {
    return NextResponse.json({ error: "User ID not found" }, { status: 400 });
  }

  try {
    const body = await request.json();
    const { id, action } = body;

    if (!id || !action) {
      return NextResponse.json(
        { error: "Missing required fields: id and action" },
        { status: 400 }
      );
    }

    if (action !== "approve" && action !== "reject") {
      return NextResponse.json(
        { error: "Invalid action. Must be 'approve' or 'reject'" },
        { status: 400 }
      );
    }

    if (action === "approve") {
      await approveWaitlistRequest({
        id,
        approvedBy: session.user.id,
      });
    } else {
      await rejectWaitlistRequest({
        id,
        approvedBy: session.user.id,
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to process waitlist request",
        message:
          error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
