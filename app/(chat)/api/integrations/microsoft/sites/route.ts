import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { graphJson } from "@/lib/integrations/microsoft/graph";
import { getIntegrationConnectionForUser } from "@/lib/db/queries";

type GraphSitesResponse = {
  value?: Array<{
    id?: string;
    name?: string;
    webUrl?: string;
    displayName?: string;
  }>;
  "@odata.nextLink"?: string;
};

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query")?.trim() ?? "";

  // If query looks like a SharePoint URL, try to fetch that specific site
  const urlMatch = query.match(/https?:\/\/([^/]+)\/sites\/([^/?]+)/i);
  if (urlMatch) {
    const [, hostname, sitePath] = urlMatch;
    try {
      // Query specific site by hostname and path
      const siteUrl = `https://graph.microsoft.com/v1.0/sites/${hostname}:/sites/${sitePath}`;
      const siteData = await graphJson<{
        id?: string;
        name?: string;
        webUrl?: string;
        displayName?: string;
      }>(session.user.id, siteUrl);
      
      if (typeof siteData.id === "string") {
        return NextResponse.json({
          sites: [{
            id: siteData.id,
            name: typeof siteData.displayName === "string" ? siteData.displayName : typeof siteData.name === "string" ? siteData.name : null,
            webUrl: typeof siteData.webUrl === "string" ? siteData.webUrl : null,
          }],
        }, { status: 200 });
      }
    } catch (specificError) {
      // If specific site query fails, continue with general search
      console.error("Failed to fetch specific site:", specificError);
    }
  }

  try {
    const allSites: Array<{ id: string; name: string | null; webUrl: string | null }> = [];
    
    // Get tenant info to query by hostname
    const connection = await getIntegrationConnectionForUser({
      userId: session.user.id,
      provider: "microsoft",
    });
    
    const accountEmail = connection?.accountEmail;
    let hostname: string | null = null;
    
    // Extract hostname from email (e.g., jeff@AdventureFlow.onmicrosoft.com -> adventureflow.sharepoint.com)
    // Or try to get it from the account email domain
    if (accountEmail) {
      const domainMatch = accountEmail.match(/@([^.]+)\.onmicrosoft\.com$/i);
      if (domainMatch) {
        hostname = `${domainMatch[1].toLowerCase()}.sharepoint.com`;
      }
    }

    // Strategy 1: Try to query root site by hostname if we have it
    if (hostname) {
      try {
        const rootSiteUrl = `https://graph.microsoft.com/v1.0/sites/${hostname}`;
        const rootSite = await graphJson<{
          id?: string;
          name?: string;
          webUrl?: string;
          displayName?: string;
        }>(session.user.id, rootSiteUrl);
        
        if (typeof rootSite.id === "string") {
          allSites.push({
            id: rootSite.id,
            name: typeof rootSite.displayName === "string" ? rootSite.displayName : typeof rootSite.name === "string" ? rootSite.name : null,
            webUrl: typeof rootSite.webUrl === "string" ? rootSite.webUrl : null,
          });
        }
        
        // Try to get sites under this hostname
        try {
          const sitesUnderHostUrl = `https://graph.microsoft.com/v1.0/sites/${hostname}/sites`;
          const sitesData = await graphJson<GraphSitesResponse>(session.user.id, sitesUnderHostUrl);
          const batch = (sitesData.value ?? [])
            .map((s) => ({
              id: typeof s.id === "string" ? s.id : null,
              name: typeof s.displayName === "string" ? s.displayName : typeof s.name === "string" ? s.name : null,
              webUrl: typeof s.webUrl === "string" ? s.webUrl : null,
            }))
            .filter((s): s is { id: string; name: string | null; webUrl: string | null } => s.id !== null);
          allSites.push(...batch);
        } catch (sitesError) {
          console.error(`Failed to get sites under hostname ${hostname}:`, sitesError);
        }
      } catch (rootError) {
        console.error(`Failed to query root site for ${hostname}:`, rootError);
      }
    }

    // Remove duplicates by ID
    const uniqueSites = Array.from(
      new Map(allSites.map((s) => [s.id, s])).values()
    );

    // Filter client-side if query provided
    let sites = uniqueSites;
    if (query.length > 0) {
      const lowerQuery = query.toLowerCase();
      sites = uniqueSites.filter(
        (s) =>
          s.name?.toLowerCase().includes(lowerQuery) ||
          s.webUrl?.toLowerCase().includes(lowerQuery)
      );
    }

    return NextResponse.json({ sites }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list sites";
    console.error("Graph API sites error:", message);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


