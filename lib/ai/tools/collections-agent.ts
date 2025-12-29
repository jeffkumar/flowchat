import { inferSourceTypeFromNamespace } from "@/lib/rag/source-routing";
import { formatRetrievedContext, queryTurbopuffer } from "@/lib/rag/turbopuffer";

type CollectionRow = Record<string, unknown> & {
  $dist?: number;
  content?: string;
};

export type CollectionsQueryArgs = {
  namespaces: string[];
  query: string;
  topK: number;
  ignoredDocIds?: string[];
  // Slack-only filters inferred by the caller.
  slackChannelName?: string | null;
  slackUserName?: string | null;
  // Optional server-side time filter (when fields exist).
  sourceCreatedAtMsRange?: { startMs: number; endMs: number } | null;
};

export async function queryCollectionsNamespaces({
  namespaces,
  query,
  topK,
  ignoredDocIds,
  slackChannelName,
  slackUserName,
  sourceCreatedAtMsRange,
}: CollectionsQueryArgs): Promise<CollectionRow[][]> {
  const range = sourceCreatedAtMsRange ?? null;

  return await Promise.all(
    namespaces.map(async (ns) => {
      const filterParts: unknown[] = [];

      if (Array.isArray(ignoredDocIds) && ignoredDocIds.length > 0) {
        filterParts.push(["Not", ["doc_id", "In", ignoredDocIds]]);
      }

      const inferredSourceType = inferSourceTypeFromNamespace(ns);
      const isSlackNamespace = inferredSourceType === "slack";
      if (isSlackNamespace) {
        if (typeof slackChannelName === "string" && slackChannelName.length > 0) {
          filterParts.push(["channel_name", "Eq", slackChannelName]);
        }
        if (typeof slackUserName === "string" && slackUserName.length > 0) {
          filterParts.push(["user_name", "Eq", slackUserName]);
        }
      }

      if (range) {
        filterParts.push(["sourceCreatedAtMs", "Gte", range.startMs]);
        filterParts.push(["sourceCreatedAtMs", "Lt", range.endMs]);
      }

      const filters =
        filterParts.length === 0
          ? undefined
          : filterParts.length === 1
            ? filterParts[0]
            : ["And", filterParts];

      const nsRows = await queryTurbopuffer({
        query,
        topK,
        namespace: ns,
        filters,
      });

      return nsRows.map((r) => ({
        ...(r as Record<string, unknown>),
        sourceType:
          typeof (r as any).sourceType === "string"
            ? (r as any).sourceType
            : (inferredSourceType ?? ""),
      })) as CollectionRow[];
    })
  );
}

export function formatCollectionsRetrievedContext(rows: CollectionRow[]): string {
  return formatRetrievedContext(rows);
}


