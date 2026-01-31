import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";

const QuerySchema = z.object({
  q: z.string().min(1),
});

type GraphSearchResponse = {
  value?: Array<{
    searchTerms?: string[];
    hitsContainers?: Array<{
      hits?: Array<{
        hitId: string;
        resource: {
          "@odata.type": string;
          id: string;
          name: string;
          webUrl: string;
          size?: number;
          createdDateTime?: string;
          lastModifiedDateTime?: string;
          parentReference?: {
            driveId: string;
            id: string;
            siteId?: string;
            path?: string;
          };
          file?: Record<string, unknown>;
          folder?: Record<string, unknown>;
        };
      }>;
      total?: number;
      moreResultsAvailable?: boolean;
    }>;
  }>;
};

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    q: searchParams.get("q") ?? "",
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Missing query" }, { status: 400 });
  }

  try {
    const url = "https://graph.microsoft.com/v1.0/search/query";
    const body = {
      requests: [
        {
          entityTypes: ["driveItem"],
          query: {
            queryString: parsed.data.q,
          },
          from: 0,
          size: 20,
          fields: [
            "id",
            "name",
            "webUrl",
            "size",
            "parentReference",
            "file",
            "folder",
            "lastModifiedDateTime",
          ],
        },
      ],
    };

    // Note: graphJson is a GET helper, so we need to implement POST manually or update graphJson.
    // Since graphJson is simple, I'll just replicate the token fetching logic here or inline it.
    // Actually, let's use the helper to get the token and do the fetch directly.
    // Wait, graphJson takes a URL and does a GET. I'll just import getMicrosoftAccessTokenForUser.
    
    // Importing getMicrosoftAccessTokenForUser dynamically to avoid circular deps if any? No, it's fine.
    const { getMicrosoftAccessTokenForUser } = await import(
      "@/lib/integrations/microsoft/graph"
    );
    const token = await getMicrosoftAccessTokenForUser(session.user.id);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `Search request failed (${res.status})`);
    }

    const data = (await res.json()) as GraphSearchResponse;
    const hits = data.value?.[0]?.hitsContainers?.[0]?.hits ?? [];

    const rawItems = hits
      .map((hit) => {
        const r = hit.resource;
        // Only return items that have a driveId (needed for import)
        if (!r.parentReference?.driveId) return null;

        return {
          id: r.id,
          name: r.name,
          webUrl: r.webUrl,
          size: r.size ?? null,
          lastModifiedDateTime: r.lastModifiedDateTime ?? null,
          driveId: r.parentReference.driveId,
          parentId: r.parentReference.id,
          isFolder: Boolean(r.folder),
          isFile: Boolean(r.file),
          path: r.parentReference.path, // useful for display
        };
      })
      .filter((i): i is NonNullable<typeof i> => i !== null);

    // De-dupe (Graph search can return duplicates across containers)
    const items = Array.from(
      new Map(rawItems.map((i) => [`${i.driveId}:${i.id}`, i] as const)).values()
    );

    return NextResponse.json({ items }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to search items";
    console.error("[Microsoft Search] Error:", message);
    
    // Return appropriate status codes based on error type
    if (message === "Microsoft not connected" || message === "Microsoft session expired") {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

