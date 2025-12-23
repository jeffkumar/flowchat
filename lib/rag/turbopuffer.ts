type TurbopufferRow = {
  $dist?: number;
  content?: string;
  [key: string]: unknown;
};

type OpenAIEmbeddingResponse = {
  data: Array<{ embedding: number[] }>;
};

const turbopufferApiKey = process.env.TURBOPUFFER_API_KEY;
const turbopufferNamespace = process.env.TURBOPUFFER_NAMESPACE;

type EmbeddingsProvider = "auto" | "openai" | "baseten";

function getEmbeddingsProviderFromEnv(): EmbeddingsProvider {
  const raw = process.env.EMBEDDINGS_PROVIDER;
  const value = raw?.trim().toLowerCase();
  if (!value) return "openai";
  if (value === "auto" || value === "openai" || value === "baseten") {
    return value;
  }
  throw new Error(
    `Invalid EMBEDDINGS_PROVIDER="${raw}". Expected "openai" | "baseten" | "auto".`
  );
}

const EMBEDDINGS_TIMEOUT_MS = 20_000;
const EMBEDDINGS_MAX_RETRIES = 2;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timeoutId);
  });
}

function shouldRetryEmbeddingsResponse(status: number): boolean {
  // Retry transient server-side errors.
  return status >= 500;
}

type TurbopufferWriteResponse = {
  rows_deleted?: number;
  rows_remaining?: boolean;
};

export type TurbopufferUpsertRow = {
  id: string;
  vector: number[];
  content: string;
  [key: string]: unknown;
};

async function writeToTurbopuffer({
  namespace,
  body,
}: {
  namespace: string;
  body: Record<string, unknown>;
}): Promise<TurbopufferWriteResponse> {
  if (!turbopufferApiKey) {
    throw new Error("Missing TURBOPUFFER_API_KEY");
  }

  const response = await fetch(
    `https://api.turbopuffer.com/v2/namespaces/${namespace}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${turbopufferApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const message = await response.text();
    if (message.includes("was not found")) {
      return { rows_deleted: 0, rows_remaining: false };
    }
    // throw new Error(`Turbopuffer write failed: ${message}`);
    console.error(`Turbopuffer write failed: ${message}`);
    return { rows_deleted: 0, rows_remaining: false };
  }

  const json = (await response.json().catch(() => ({}))) as TurbopufferWriteResponse;
  return json;
}

export async function createEmbedding(input: string): Promise<number[]> {
  const provider = getEmbeddingsProviderFromEnv();
  const basetenApiKey = process.env.BASETEN_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;

  const shouldUseBaseten = provider === "baseten" || (provider === "auto" && Boolean(basetenApiKey));

  if (shouldUseBaseten) {
    if (!basetenApiKey) {
      throw new Error('EMBEDDINGS_PROVIDER="baseten" requires BASETEN_API_KEY');
    }

    const url =
      "https://model-7wl7dm7q.api.baseten.co/environments/production/predict";
    const init: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${basetenApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "mixedbread-ai/mxbai-embed-large-v1",
        input,
        encoding_format: "float",
      }),
    };

    const attempt = async (retry: number): Promise<number[]> => {
      const response = await fetchWithTimeout(url, init, EMBEDDINGS_TIMEOUT_MS);
      if (!response.ok) {
        const message = await response.text();
        if (retry < EMBEDDINGS_MAX_RETRIES && shouldRetryEmbeddingsResponse(response.status)) {
          await delay(250 * 3 ** retry);
          return attempt(retry + 1);
        }
        throw new Error(
          `[embeddings:baseten] request failed (status ${response.status}): ${message}`
        );
      }

      const json = (await response.json()) as OpenAIEmbeddingResponse;
      const first = json.data[0];
      if (!first || !Array.isArray(first.embedding)) {
        throw new Error("[embeddings:baseten] invalid response");
      }
      return first.embedding;
    };

    return attempt(0);
  }

  if (!openaiApiKey) {
    if (provider === "openai") {
      throw new Error('EMBEDDINGS_PROVIDER="openai" requires OPENAI_API_KEY');
    }
    throw new Error("Missing OPENAI_API_KEY (or set EMBEDDINGS_PROVIDER=baseten with BASETEN_API_KEY)");
  }

  const url = "https://api.openai.com/v1/embeddings";
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input,
      encoding_format: "float",
    }),
  };

  const attempt = async (retry: number): Promise<number[]> => {
    const response = await fetchWithTimeout(url, init, EMBEDDINGS_TIMEOUT_MS);
    if (!response.ok) {
      const message = await response.text();
      if (retry < EMBEDDINGS_MAX_RETRIES && shouldRetryEmbeddingsResponse(response.status)) {
        await delay(250 * 3 ** retry);
        return attempt(retry + 1);
      }
      throw new Error(
        `[embeddings:openai] request failed (status ${response.status}): ${message}`
      );
    }

    const json = (await response.json()) as OpenAIEmbeddingResponse;
    const first = json.data[0];
    if (!first || !Array.isArray(first.embedding)) {
      throw new Error("[embeddings:openai] invalid response");
    }
    return first.embedding;
  };

  return attempt(0);
}

export async function upsertRowsToTurbopuffer({
  namespace,
  rows,
}: {
  namespace: string;
  rows: TurbopufferUpsertRow[];
}) {
  await writeToTurbopuffer({
    namespace,
    body: {
      upsert_rows: rows,
      distance_metric: "cosine_distance",
    },
  });
}

export async function deleteByFilterFromTurbopuffer({
  namespace,
  filters,
}: {
  namespace: string;
  filters: unknown;
}): Promise<{ rowsDeleted: number }> {
  let totalDeleted = 0;
  let rowsRemaining = true;

  while (rowsRemaining) {
    const result = await writeToTurbopuffer({
      namespace,
      body: {
        delete_by_filter: filters,
        delete_by_filter_allow_partial: true,
        distance_metric: "cosine_distance",
      },
    });

    totalDeleted += result.rows_deleted ?? 0;
    rowsRemaining = result.rows_remaining === true;
  }

  return { rowsDeleted: totalDeleted };
}

export async function queryTurbopuffer({
  query,
  topK = 20,
  namespace,
  filters,
}: {
  query: string;
  topK?: number;
  namespace?: string;
  filters?: unknown;
}): Promise<TurbopufferRow[]> {
  if (!turbopufferApiKey) {
    throw new Error("Missing TURBOPUFFER_API_KEY");
  }
  const effectiveNamespace = namespace ?? turbopufferNamespace;
  if (!effectiveNamespace) {
    throw new Error("Missing TURBOPUFFER_NAMESPACE");
  }

  const vector = await createEmbedding(query);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  const response = await fetch(
    `https://api.turbopuffer.com/v2/namespaces/${effectiveNamespace}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${turbopufferApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        rank_by: ["vector", "ANN", vector],
        top_k: topK,
        include_attributes: true,
        filters,
      }),
      signal: controller.signal,
    }
  ).finally(() => {
    clearTimeout(timeoutId);
  });

  if (!response.ok) {
    const message = await response.text();
    if (message.includes("was not found")) {
      return [];
    }
    throw new Error(`Turbopuffer query failed: ${message}`);
  }

  const json = (await response.json()) as { rows?: TurbopufferRow[] };
  return json.rows ?? [];
}

export function formatRetrievedContext(rows: TurbopufferRow[]): string {
  if (rows.length === 0) {
    return "";
  }

  const formatted = rows
    .map((row, index) => {
      const contentValue = row.content ?? "";
      const content = String(contentValue);
      const sourceType =
        typeof (row as unknown as Record<string, unknown>).sourceType === "string"
          ? ((row as unknown as Record<string, unknown>).sourceType as string)
          : "";
      const maxChars = sourceType === "docs" ? 3000 : 1000;
      const truncated =
        content.length > maxChars ? `${content.slice(0, maxChars)}…` : content;
      const channelName =
        typeof row.channel_name === "string" ? row.channel_name : "";
      const userName = typeof row.user_name === "string" ? row.user_name : "";
      const ts = typeof row.ts === "string" ? row.ts : "";

      const headerParts: string[] = [];
      if (channelName) headerParts.push(`#${channelName}`);
      if (userName) headerParts.push(userName);
      if (ts) headerParts.push(`ts=${ts}`);

      const header =
        headerParts.length > 0
          ? headerParts.join(" · ")
          : `result ${String(index + 1)}`;

      return `${header}\n${truncated}`;
    })
    .join("\n\n");

  return formatted;
}
