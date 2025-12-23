import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { graphJson } from "@/lib/integrations/microsoft/graph";

const QuerySchema = z.object({
  url: z.string().url(),
});

function toBase64Url(input: string) {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

type GraphDriveItem = {
  id?: string;
  name?: string;
  webUrl?: string;
  size?: number;
  folder?: Record<string, unknown>;
  file?: Record<string, unknown>;
  parentReference?: {
    driveId?: string;
    id?: string;
    siteId?: string;
    path?: string;
  };
};

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    url: searchParams.get("url") ?? "",
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Missing or invalid url" }, { status: 400 });
  }

  try {
    const shareId = `u!${toBase64Url(parsed.data.url)}`;
    const graphUrl = new URL(
      `https://graph.microsoft.com/v1.0/shares/${encodeURIComponent(shareId)}/driveItem`
    );
    graphUrl.searchParams.set(
      "$select",
      "id,name,webUrl,size,folder,file,parentReference"
    );

    const item = await graphJson<GraphDriveItem>(session.user.id, graphUrl.toString());

    const itemId = typeof item.id === "string" && item.id.length > 0 ? item.id : null;
    const driveId =
      typeof item.parentReference?.driveId === "string" &&
      item.parentReference.driveId.length > 0
        ? item.parentReference.driveId
        : null;
    const parentId =
      typeof item.parentReference?.id === "string" && item.parentReference.id.length > 0
        ? item.parentReference.id
        : null;

    if (!itemId || !driveId) {
      return NextResponse.json(
        { error: "Could not resolve driveId/itemId from URL" },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        driveId,
        item: {
          id: itemId,
          name: typeof item.name === "string" ? item.name : null,
          webUrl: typeof item.webUrl === "string" ? item.webUrl : null,
          size: typeof item.size === "number" && Number.isFinite(item.size) ? item.size : null,
          isFolder: Boolean(item.folder),
          isFile: Boolean(item.file),
          parentId,
          siteId:
            typeof item.parentReference?.siteId === "string" ? item.parentReference.siteId : null,
          path:
            typeof item.parentReference?.path === "string" ? item.parentReference.path : null,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve SharePoint URL";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


