import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { isDevelopmentEnvironment } from "@/lib/constants";
import { createPkcePair, createState } from "@/lib/integrations/microsoft/oauth";

const MS_AUTHORIZE_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";

const Scope = z.enum([
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Files.Read.All",
  "Sites.Read.All",
]);

function parseScopes(input: string) {
  const raw = input.split(/\s+/).filter((s) => s.length > 0);
  const safe: string[] = [];
  for (const s of raw) {
    const parsed = Scope.safeParse(s);
    if (parsed.success) safe.push(parsed.data);
  }
  return safe.length > 0 ? safe : ["openid", "profile", "email", "offline_access", "User.Read", "Files.Read.All", "Sites.Read.All"];
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI;

  if (typeof clientId !== "string" || clientId.length === 0) {
    return NextResponse.json(
      { error: "MICROSOFT_CLIENT_ID is not set" },
      { status: 500 }
    );
  }

  if (typeof redirectUri !== "string" || redirectUri.length === 0) {
    return NextResponse.json(
      { error: "MICROSOFT_REDIRECT_URI is not set" },
      { status: 500 }
    );
  }

  const { searchParams } = new URL(request.url);
  const scopes = parseScopes(searchParams.get("scopes") ?? "");
  const returnTo = searchParams.get("returnTo") ?? "/integrations";

  const { verifier, challenge } = createPkcePair();
  const state = createState();

  const authorizeUrl = new URL(MS_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_mode", "query");
  authorizeUrl.searchParams.set("scope", scopes.join(" "));
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("code_challenge", challenge);

  const response = NextResponse.redirect(authorizeUrl);

  const cookieBase = {
    httpOnly: true,
    // OAuth callback is a cross-site redirect (login.microsoftonline.com -> our domain).
    // In production, use SameSite=None; Secure so state/verifier cookies are reliably sent.
    sameSite: isDevelopmentEnvironment ? ("lax" as const) : ("none" as const),
    secure: !isDevelopmentEnvironment,
    path: "/",
    // Avoid stale state/verifier if user restarts the flow later.
    maxAge: 10 * 60, // 10 minutes
  };

  response.cookies.set({ name: "ms_oauth_state", value: state, ...cookieBase });
  response.cookies.set({
    name: "ms_pkce_verifier",
    value: verifier,
    ...cookieBase,
  });
  response.cookies.set({
    name: "ms_return_to",
    value: returnTo,
    ...cookieBase,
  });

  return response;
}


