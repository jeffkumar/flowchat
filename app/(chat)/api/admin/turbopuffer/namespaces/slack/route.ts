import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { isAdminSession } from "@/lib/admin";
import { ChatSDKError } from "@/lib/errors";
import { listMostRecentSlackInNamespace } from "@/lib/rag/turbopuffer-admin";

const BodySchema = z.object({
  namespace: z.string().trim().min(1),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!isAdminSession(session)) {
    return new ChatSDKError("unauthorized:auth").toResponse();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new ChatSDKError("bad_request:api", "Invalid JSON body").toResponse();
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return new ChatSDKError("bad_request:api", "Invalid request").toResponse();
  }

  try {
    const rows = await listMostRecentSlackInNamespace({
      namespace: parsed.data.namespace,
      limit: 25,
    });
    return Response.json({ rows }, { status: 200 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list slack rows";
    return new ChatSDKError("bad_request:api", message).toResponse();
  }
}


