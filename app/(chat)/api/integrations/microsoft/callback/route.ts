import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { isDevelopmentEnvironment } from "@/lib/constants";
import { upsertIntegrationConnection } from "@/lib/db/queries";
import { encryptSecret } from "@/lib/integrations/crypto";
import { decodeJwtPayload } from "@/lib/integrations/microsoft/oauth";

const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName";

type IdTokenPayload = {
  tid?: string;
};

const QuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  error_description: z.string().min(1).optional(),
});

type TokenResponse = {
  token_type?: string;
  scope?: string;
  expires_in?: number;
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
};

type GraphMe = {
  id?: string;
  mail?: string | null;
  userPrincipalName?: string | null;
};

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI;

  if (typeof clientId !== "string" || clientId.length === 0) {
    return NextResponse.json(
      { error: "MICROSOFT_CLIENT_ID is not set" },
      { status: 500 }
    );
  }
  if (typeof clientSecret !== "string" || clientSecret.length === 0) {
    return NextResponse.json(
      { error: "MICROSOFT_CLIENT_SECRET is not set" },
      { status: 500 }
    );
  }
  if (typeof redirectUri !== "string" || redirectUri.length === 0) {
    return NextResponse.json(
      { error: "MICROSOFT_REDIRECT_URI is not set" },
      { status: 500 }
    );
  }

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries())
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid callback query" }, { status: 400 });
  }

  const { code, state, error, error_description } = parsed.data;
  if (error) {
    return NextResponse.json(
      { error, error_description: error_description ?? null },
      { status: 400 }
    );
  }

  if (!code || !state) {
    return NextResponse.json(
      { error: "Missing code or state" },
      { status: 400 }
    );
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookies = new Map(
    cookieHeader
      .split(";")
      .map((pair) => pair.trim())
      .filter((pair) => pair.length > 0)
      .map((pair) => {
        const idx = pair.indexOf("=");
        if (idx === -1) return [pair, ""];
        return [pair.slice(0, idx), decodeURIComponent(pair.slice(idx + 1))];
      })
  );

  const expectedState = cookies.get("ms_oauth_state");
  const verifier = cookies.get("ms_pkce_verifier");
  const returnTo = cookies.get("ms_return_to") ?? "/integrations";

  if (!expectedState || !verifier || expectedState !== state) {
    return NextResponse.json({ error: "Invalid state" }, { status: 400 });
  }

  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", redirectUri);
  body.set("code_verifier", verifier);

  const tokenRes = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    return NextResponse.json(
      { error: "Token exchange failed", details: text || null },
      { status: 400 }
    );
  }

  const tokenJson = (await tokenRes.json()) as TokenResponse;
  const accessToken = tokenJson.access_token;
  const refreshToken = tokenJson.refresh_token;

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return NextResponse.json({ error: "Missing access_token" }, { status: 400 });
  }

  const meRes = await fetch(GRAPH_ME_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!meRes.ok) {
    const text = await meRes.text().catch(() => "");
    return NextResponse.json(
      { error: "Graph /me failed", details: text || null },
      { status: 400 }
    );
  }

  const me = (await meRes.json()) as GraphMe;
  const providerAccountId =
    typeof me.id === "string" && me.id.length > 0 ? me.id : null;
  const accountEmail =
    (typeof me.mail === "string" && me.mail.length > 0
      ? me.mail
      : typeof me.userPrincipalName === "string" && me.userPrincipalName.length > 0
        ? me.userPrincipalName
        : null) ?? null;

  const idToken = typeof tokenJson.id_token === "string" ? tokenJson.id_token : null;
  const payload = idToken ? decodeJwtPayload<IdTokenPayload>(idToken) : null;
  const tenantId =
    payload && typeof payload.tid === "string" && payload.tid.length > 0
      ? payload.tid
      : null;

  const expiresInSec =
    typeof tokenJson.expires_in === "number" && Number.isFinite(tokenJson.expires_in)
      ? tokenJson.expires_in
      : null;
  const expiresAt = expiresInSec ? new Date(Date.now() + expiresInSec * 1000) : null;

  const scopes =
    typeof tokenJson.scope === "string" && tokenJson.scope.length > 0
      ? tokenJson.scope.split(/\s+/).filter((s) => s.length > 0)
      : [];

  const accessTokenEnc = encryptSecret(accessToken);
  const refreshTokenEnc =
    typeof refreshToken === "string" && refreshToken.length > 0
      ? encryptSecret(refreshToken)
      : null;

  await upsertIntegrationConnection({
    userId: session.user.id,
    provider: "microsoft",
    accountEmail,
    providerAccountId,
    tenantId,
    scopes,
    accessTokenEnc,
    refreshTokenEnc,
    expiresAt,
  });

  const response = NextResponse.redirect(new URL(returnTo, request.url));

  const cookieBase = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: !isDevelopmentEnvironment,
    path: "/",
  };

  response.cookies.set({ name: "ms_oauth_state", value: "", maxAge: 0, ...cookieBase });
  response.cookies.set({
    name: "ms_pkce_verifier",
    value: "",
    maxAge: 0,
    ...cookieBase,
  });
  response.cookies.set({ name: "ms_return_to", value: "", maxAge: 0, ...cookieBase });

  return response;
}


