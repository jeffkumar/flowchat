import "server-only";

import { Turbopuffer } from "@turbopuffer/turbopuffer";

// NOTE: Listing namespaces requires a dashboard/admin token. Namespace-scoped tokens
// can still read/write known namespaces but typically cannot enumerate all namespaces.
const turbopufferAdminApiKey =
  process.env.TURBOPUFFER_ADMIN_API_KEY ?? process.env.TURBOPUFFER_ADMIN_KEY;
const turbopufferRegion = process.env.TURBOPUFFER_REGION ?? "gcp-us-central1";

type NamespaceListResponse =
  | string[]
  | {
      namespaces?: unknown;
      data?: unknown;
    };

type TurbopufferDocsRow = {
  id: string;
  indexedAtMs?: number;
  sourceCreatedAtMs?: number;
  doc_id?: string;
  filename?: string;
  source_url?: string | null;
  mime_type?: string;
  chunk_index?: number;
};

type TurbopufferSlackRow = {
  id: string;
  ts?: string;
  content?: string;
  sourceCreatedAtMs?: number;
  indexedAtMs?: number;
  channel_name?: string;
  user_name?: string;
  url?: string;
};

function normalizeNamespaces(input: unknown): string[] {
  if (Array.isArray(input)) {
    const direct = input.filter((x): x is string => typeof x === "string" && x.length > 0);
    if (direct.length > 0) return direct;

    const byName = input
      .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>).name : null))
      .filter((x): x is string => typeof x === "string" && x.length > 0);
    if (byName.length > 0) return byName;
  }

  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    return normalizeNamespaces(obj.namespaces ?? obj.data);
  }

  return [];
}

export async function listTurbopufferNamespaces(): Promise<string[]> {
  if (!turbopufferAdminApiKey) {
    throw new Error(
      "Missing TURBOPUFFER_ADMIN_API_KEY (or TURBOPUFFER_ADMIN_KEY)"
    );
  }

  const tpuf = new Turbopuffer({
    apiKey: turbopufferAdminApiKey,
    region: turbopufferRegion,
  });

  // SDK lists namespaces via /v1/namespaces (paged)
  const namespaces: string[] = [];
  for await (const ns of tpuf.namespaces()) {
    const id = ns && typeof (ns as any).id === "string" ? (ns as any).id : null;
    if (id && id.length > 0) {
      namespaces.push(id);
    }
  }

  // Stable sort for UI
  namespaces.sort((a, b) => a.localeCompare(b));
  return namespaces;
}

export async function deleteTurbopufferNamespace(namespace: string) {
  const trimmed = namespace.trim();
  if (trimmed.length === 0) {
    throw new Error("Missing namespace");
  }

  if (!turbopufferAdminApiKey) {
    throw new Error(
      "Missing TURBOPUFFER_ADMIN_API_KEY (or TURBOPUFFER_ADMIN_KEY)"
    );
  }

  const tpuf = new Turbopuffer({
    apiKey: turbopufferAdminApiKey,
    region: turbopufferRegion,
  });

  const ns = tpuf.namespace(trimmed);
  await ns.deleteAll();
  return { deleted: true };
}

function getAdminKeyOrThrow(): string {
  if (!turbopufferAdminApiKey) {
    throw new Error(
      "Missing TURBOPUFFER_ADMIN_API_KEY (or TURBOPUFFER_ADMIN_KEY)"
    );
  }
  return turbopufferAdminApiKey;
}

export async function listMostRecentDocsInNamespace({
  namespace,
  limit = 25,
}: {
  namespace: string;
  limit?: number;
}): Promise<TurbopufferDocsRow[]> {
  const trimmed = namespace.trim();
  if (trimmed.length === 0) {
    throw new Error("Missing namespace");
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("Invalid limit");
  }

  const apiKey = getAdminKeyOrThrow();
  const url = `https://${turbopufferRegion}.turbopuffer.com/v2/namespaces/${encodeURIComponent(trimmed)}/query`;

  const orderFields = ["indexedAtMs", "sourceCreatedAtMs"] as const;
  const includeAttributes = [
    "indexedAtMs",
    "sourceCreatedAtMs",
    "doc_id",
    "filename",
    "source_url",
    "mime_type",
    "chunk_index",
  ] as const;

  let lastError: Error | null = null;
  for (const field of orderFields) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Order-by attribute query: https://turbopuffer.com/docs/query
        rank_by: [field, "desc"],
        filters: ["sourceType", "Eq", "docs"],
        limit: Math.min(25, Math.trunc(limit)),
        include_attributes: [...includeAttributes],
      }),
    });

    if (response.ok) {
      const json = (await response.json().catch(() => null)) as
        | { rows?: unknown }
        | null;
      const rowsUnknown = json?.rows;
      if (!Array.isArray(rowsUnknown)) return [];

      const rows: TurbopufferDocsRow[] = [];
      for (const r of rowsUnknown) {
        if (!r || typeof r !== "object") continue;
        const obj = r as Record<string, unknown>;
        const id = typeof obj.id === "string" ? obj.id : "";
        if (!id) continue;

        rows.push({
          id,
          indexedAtMs:
            typeof obj.indexedAtMs === "number" ? obj.indexedAtMs : undefined,
          sourceCreatedAtMs:
            typeof obj.sourceCreatedAtMs === "number"
              ? obj.sourceCreatedAtMs
              : undefined,
          doc_id: typeof obj.doc_id === "string" ? obj.doc_id : undefined,
          filename: typeof obj.filename === "string" ? obj.filename : undefined,
          source_url:
            typeof obj.source_url === "string" || obj.source_url === null
              ? (obj.source_url as string | null)
              : undefined,
          mime_type: typeof obj.mime_type === "string" ? obj.mime_type : undefined,
          chunk_index:
            typeof obj.chunk_index === "number" ? obj.chunk_index : undefined,
        });
      }

      return rows;
    }

    const message = await response.text().catch(() => "");
    // If this was a validation/schema error (common when a namespace doesn't have that field),
    // try the next fallback order field.
    if (response.status === 400) {
      lastError = new Error(
        message.length > 0
          ? `Turbopuffer query failed (${response.status}): ${message}`
          : `Turbopuffer query failed (${response.status})`
      );
      continue;
    }

    throw new Error(
      message.length > 0
        ? `Turbopuffer query failed (${response.status}): ${message}`
        : `Turbopuffer query failed (${response.status})`
    );
  }

  throw lastError ?? new Error("Turbopuffer query failed (400)");
}

export async function listMostRecentSlackInNamespace({
  namespace,
  limit = 25,
}: {
  namespace: string;
  limit?: number;
}): Promise<TurbopufferSlackRow[]> {
  const trimmed = namespace.trim();
  if (trimmed.length === 0) {
    throw new Error("Missing namespace");
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("Invalid limit");
  }

  const apiKey = getAdminKeyOrThrow();
  const url = `https://${turbopufferRegion}.turbopuffer.com/v2/namespaces/${encodeURIComponent(trimmed)}/query`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      // Order-by attribute query: https://turbopuffer.com/docs/query
      // Per request: use Slack's native ts field for recency ordering.
      rank_by: ["ts", "desc"],
      // NOTE: Older slack namespaces may not have a reliable `sourceType` attribute.
      // Since this endpoint is explicitly scoped to the selected namespace, don't filter.
      limit: Math.min(25, Math.trunc(limit)),
      include_attributes: [
        "ts",
        "sourceType",
        "content",
        "sourceCreatedAtMs",
        "indexedAtMs",
        "channel_name",
        "user_name",
        "url",
      ],
    }),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(
      message.length > 0
        ? `Turbopuffer query failed (${response.status}): ${message}`
        : `Turbopuffer query failed (${response.status})`
    );
  }

  const json = (await response.json().catch(() => null)) as
    | { rows?: unknown }
    | null;
  const rowsUnknown = json?.rows;
  if (!Array.isArray(rowsUnknown)) return [];

  const rows: TurbopufferSlackRow[] = [];
  for (const r of rowsUnknown) {
    if (!r || typeof r !== "object") continue;
    const obj = r as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : "";
    if (!id) continue;

    rows.push({
      id,
      ts: typeof obj.ts === "string" ? obj.ts : undefined,
      content: typeof obj.content === "string" ? obj.content : undefined,
      sourceCreatedAtMs:
        typeof obj.sourceCreatedAtMs === "number" ? obj.sourceCreatedAtMs : undefined,
      indexedAtMs: typeof obj.indexedAtMs === "number" ? obj.indexedAtMs : undefined,
      channel_name: typeof obj.channel_name === "string" ? obj.channel_name : undefined,
      user_name: typeof obj.user_name === "string" ? obj.user_name : undefined,
      url: typeof obj.url === "string" ? obj.url : undefined,
    });
  }

  return rows;
}

