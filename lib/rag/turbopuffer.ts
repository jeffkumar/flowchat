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

async function createEmbedding(input: string): Promise<number[]> {
  if (!openaiApiKey) {
    throw new Error("Missing OPENAI_API_KEY");
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

export async function queryTurbopuffer({
  query,
  topK = 4,
}: {
  query: string;
  topK?: number;
}): Promise<TurbopufferRow[]> {
  if (!turbopufferApiKey) {
    throw new Error("Missing TURBOPUFFER_API_KEY");
  }
  if (!turbopufferNamespace) {
    throw new Error("Missing TURBOPUFFER_NAMESPACE");
  }

  const vector = await createEmbedding(query);

  const response = await fetch(
    `https://api.turbopuffer.com/v2/namespaces/${turbopufferNamespace}/query`,
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
      }),
    }
  );

  if (!response.ok) {
    const message = await response.text();
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
      const score =
        typeof row.$dist === "number" ? `score: ${row.$dist.toFixed(3)}` : "";

      const metadataPairs = Object.entries(row).filter(
        ([key]) => key !== "content" && key !== "$dist"
      );
      const metadata =
        metadataPairs.length > 0
          ? metadataPairs
              .map(([key, value]) => `${key}: ${String(value)}`)
              .join(", ")
          : "";

      return `#${index + 1}${score ? ` (${score})` : ""}${
        metadata ? `\n${metadata}` : ""
      }\n${truncated}`;
    })
    .join("\n\n");

  return formatted;
}


