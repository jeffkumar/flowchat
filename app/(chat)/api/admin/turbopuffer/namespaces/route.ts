import { auth } from "@/app/(auth)/auth";
import { isAdminSession } from "@/lib/admin";
import { listTurbopufferNamespaces } from "@/lib/rag/turbopuffer-admin";
import { ChatSDKError } from "@/lib/errors";

export async function GET() {
  const session = await auth();
  if (!isAdminSession(session)) {
    return new ChatSDKError("unauthorized:auth").toResponse();
  }

  try {
    const namespaces = await listTurbopufferNamespaces();
    return Response.json({ namespaces }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list namespaces";
    return new ChatSDKError("bad_request:api", message).toResponse();
  }
}


