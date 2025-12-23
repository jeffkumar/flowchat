import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { graphJson } from "@/lib/integrations/microsoft/graph";

const QuerySchema = z.object({
  driveId: z.string().min(1),
  itemId: z.string().min(1).optional(),
});

type GraphItemsResponse = {
  value?: Array<{
    id?: string;
    name?: string;
    webUrl?: string;
    size?: number;
    lastModifiedDateTime?: string;
    folder?: Record<string, unknown>;
    file?: Record<string, unknown>;
  }>;
  "@odata.nextLink"?: string;
};

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    driveId: searchParams.get("driveId") ?? "",
    itemId: searchParams.get("itemId") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Missing driveId" }, { status: 400 });
  }

  const { driveId, itemId } = parsed.data;
  const url = new URL(
    itemId
      ? `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/children`
      : `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/root/children`
  );
  url.searchParams.set("$top", "200");
  url.searchParams.set("$orderby", "name");

  try {
    const all: Array<{
      id: string;
      name: string | null;
      webUrl: string | null;
      size: number | null;
      lastModifiedDateTime: string | null;
      isFolder: boolean;
      isFile: boolean;
    }> = [];

    let nextLink: string | null = url.toString();
    while (nextLink && all.length < 2000) {
      const data = await graphJson<GraphItemsResponse>(session.user.id, nextLink);
      const batch = (data.value ?? [])
        .map((i) => ({
          id: typeof i.id === "string" ? i.id : null,
          name: typeof i.name === "string" ? i.name : null,
          webUrl: typeof i.webUrl === "string" ? i.webUrl : null,
          size: typeof i.size === "number" && Number.isFinite(i.size) ? i.size : null,
          lastModifiedDateTime:
            typeof i.lastModifiedDateTime === "string" ? i.lastModifiedDateTime : null,
          isFolder: Boolean(i.folder),
          isFile: Boolean(i.file),
        }))
        .filter((i): i is (typeof all)[number] => i.id !== null);

      all.push(...batch);
      nextLink = typeof data["@odata.nextLink"] === "string" ? data["@odata.nextLink"] : null;
    }

    // De-dupe by id (in case pagination overlaps)
    const items = Array.from(new Map(all.map((i) => [i.id, i])).values());
    return NextResponse.json({ items }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list items";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


