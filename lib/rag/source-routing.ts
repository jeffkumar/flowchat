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
      ? "_synergy_slackv2"
      : `_synergy_${projectId}_slackv2`;
  const docsNs =
    isDefaultProject || !projectId
      ? "_synergy_docsv2"
      : `_synergy_${projectId}_docsv2`;

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
  if (namespace.endsWith("_slack") || namespace.endsWith("_slackv2"))
    return "slack";
  if (namespace.endsWith("_docs") || namespace.endsWith("_docsv2")) return "docs";
  return null;
}
