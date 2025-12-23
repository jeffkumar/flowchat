import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { isAdminSession } from "@/lib/admin";
import { deleteTurbopufferNamespace } from "@/lib/rag/turbopuffer-admin";
import { ChatSDKError } from "@/lib/errors";

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
    const result = await deleteTurbopufferNamespace(parsed.data.namespace);
    return Response.json({ ok: true, ...result }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete namespace";
    return new ChatSDKError("bad_request:api", message).toResponse();
  }
}


