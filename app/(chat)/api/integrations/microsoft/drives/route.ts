import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { graphJson } from "@/lib/integrations/microsoft/graph";

const QuerySchema = z.object({
  siteId: z.string().min(1),
});

type GraphDrivesResponse = {
  value?: Array<{
    id?: string;
    name?: string;
    webUrl?: string;
  }>;
};

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    siteId: searchParams.get("siteId") ?? "",
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Missing siteId" }, { status: 400 });
  }

  const url = `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(parsed.data.siteId)}/drives`;

  try {
    const data = await graphJson<GraphDrivesResponse>(session.user.id, url);
    const drives = (data.value ?? [])
      .map((d) => ({
        id: typeof d.id === "string" ? d.id : null,
        name: typeof d.name === "string" ? d.name : null,
        webUrl: typeof d.webUrl === "string" ? d.webUrl : null,
      }))
      .filter((d) => d.id !== null);
    return NextResponse.json({ drives }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list drives";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


