type TurbopufferRow = {
  $dist?: number;
  content?: string;
  [key: string]: unknown;
};

type OpenAIEmbeddingResponse = {
  data: Array<{ embedding: number[] }>;
};

const openaiApiKey = process.env.OPENAI_API_KEY;
const turbopufferApiKey = process.env.TURBOPUFFER_API_KEY;
const turbopufferNamespace = process.env.TURBOPUFFER_NAMESPACE;

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
  const basetenApiKey = process.env.BASETEN_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;

  if (basetenApiKey) {
    const response = await fetch(
      "https://model-7wl7dm7q.api.baseten.co/environments/production/predict",
      {
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
      }
    );

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Baseten embedding request failed: ${message}`);
    }

    const json = (await response.json()) as OpenAIEmbeddingResponse;
    const first = json.data[0];
    if (!first || !Array.isArray(first.embedding)) {
      throw new Error("Invalid embeddings response from Baseten");
    }
    return first.embedding;
  }

  if (!openaiApiKey) {
    throw new Error("Missing OPENAI_API_KEY or BASETEN_API_KEY");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Embedding request failed: ${message}`);
  }

  const json = (await response.json()) as OpenAIEmbeddingResponse;
  const first = json.data[0];
  if (!first || !Array.isArray(first.embedding)) {
    throw new Error("Invalid embeddings response");
  }
  return first.embedding;
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
      const truncated =
        content.length > 1000 ? `${content.slice(0, 1000)}…` : content;
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
