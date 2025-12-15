export type SourceType = "slack" | "docs";

export function namespacesForSourceTypes(
  sourceTypes: SourceType[] | undefined
): string[] {
  const requested =
    Array.isArray(sourceTypes) && sourceTypes.length > 0
      ? sourceTypes
      : (["slack", "docs"] as const);

  if (requested.length === 1 && requested[0] === "slack") {
    return ["_synergy_slack"];
  }
  if (requested.length === 1 && requested[0] === "docs") {
    return ["_synergy_docs"];
  }
  return ["_synergy_slack", "_synergy_docs"];
}

export function inferSourceTypeFromNamespace(namespace: string): SourceType | null {
  if (namespace === "_synergy_slack") return "slack";
  if (namespace === "_synergy_docs") return "docs";
  return null;
}


