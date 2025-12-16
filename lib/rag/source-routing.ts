export type SourceType = "slack" | "docs";

export function namespacesForSourceTypes(
  sourceTypes: SourceType[] | undefined,
  projectId?: string | null,
  isDefaultProject = false
): string[] {
  const requested =
    Array.isArray(sourceTypes) && sourceTypes.length > 0
      ? sourceTypes
      : (["slack", "docs"] as const);

  const slackNs =
    isDefaultProject || !projectId
      ? "_synergy_slack"
      : `_synergy_${projectId}_slack`;
  const docsNs =
    isDefaultProject || !projectId
      ? "_synergy_docs"
      : `_synergy_${projectId}_docs`;

  if (requested.length === 1 && requested[0] === "slack") {
    return [slackNs];
  }
  if (requested.length === 1 && requested[0] === "docs") {
    return [docsNs];
  }
  return [slackNs, docsNs];
}

export function inferSourceTypeFromNamespace(
  namespace: string
): SourceType | null {
  if (namespace.endsWith("_slack")) return "slack";
  if (namespace.endsWith("_docs")) return "docs";
  return null;
}
