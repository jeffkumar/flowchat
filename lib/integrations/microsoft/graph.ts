import "server-only";

import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import {
  getIntegrationConnectionForUser,
  upsertIntegrationConnection,
} from "@/lib/db/queries";

const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

type TokenResponse = {
  token_type?: string;
  scope?: string;
  expires_in?: number;
  access_token?: string;
  refresh_token?: string;
};

function isExpired(expiresAt: Date | null) {
  if (!expiresAt) return true;
  return expiresAt.getTime() <= Date.now() + 60_000;
}

async function refreshMicrosoftTokens({
  refreshToken,
}: {
  refreshToken: string;
}): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}> {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;

  if (typeof clientId !== "string" || clientId.length === 0) {
    throw new Error("MICROSOFT_CLIENT_ID is not set");
  }
  if (typeof clientSecret !== "string" || clientSecret.length === 0) {
    throw new Error("MICROSOFT_CLIENT_SECRET is not set");
  }

  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);

  const res = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || "Token refresh failed");
  }

  const json = (await res.json()) as TokenResponse;
  const accessToken = json.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("Refresh response missing access_token");
  }

  const expiresInSec =
    typeof json.expires_in === "number" && Number.isFinite(json.expires_in)
      ? json.expires_in
      : null;
  const expiresAt = expiresInSec ? new Date(Date.now() + expiresInSec * 1000) : null;

  const scopes =
    typeof json.scope === "string" && json.scope.length > 0
      ? json.scope.split(/\s+/).filter((s) => s.length > 0)
      : [];

  const nextRefresh =
    typeof json.refresh_token === "string" && json.refresh_token.length > 0
      ? json.refresh_token
      : null;

  return { accessToken, refreshToken: nextRefresh, expiresAt, scopes };
}

export async function getMicrosoftAccessTokenForUser(userId: string) {
  const connection = await getIntegrationConnectionForUser({
    userId,
    provider: "microsoft",
  });

  if (!connection || connection.revokedAt) {
    throw new Error("Microsoft not connected");
  }

  const currentAccessEnc = connection.accessTokenEnc;
  const currentRefreshEnc = connection.refreshTokenEnc;

  if (!currentAccessEnc) {
    throw new Error("Missing Microsoft access token");
  }

  if (!isExpired(connection.expiresAt ?? null)) {
    return decryptSecret(currentAccessEnc);
  }

  if (!currentRefreshEnc) {
    throw new Error("Microsoft session expired");
  }

  const refreshed = await refreshMicrosoftTokens({
    refreshToken: decryptSecret(currentRefreshEnc),
  });

  await upsertIntegrationConnection({
    userId,
    provider: "microsoft",
    accountEmail: connection.accountEmail,
    providerAccountId: connection.providerAccountId,
    tenantId: connection.tenantId,
    scopes: refreshed.scopes.length > 0 ? refreshed.scopes : connection.scopes,
    accessTokenEnc: encryptSecret(refreshed.accessToken),
    refreshTokenEnc: refreshed.refreshToken ? encryptSecret(refreshed.refreshToken) : connection.refreshTokenEnc,
    expiresAt: refreshed.expiresAt,
  });

  return refreshed.accessToken;
}

export async function graphJson<T>(userId: string, url: string) {
  const token = await getMicrosoftAccessTokenForUser(userId);
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Graph request failed (${res.status})`);
  }
  return (await res.json()) as T;
}


