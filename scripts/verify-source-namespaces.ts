import { namespacesForSourceTypes } from "@/lib/rag/source-routing";

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label} failed. expected=${e} actual=${a}`);
  }
}

assertEqual(namespacesForSourceTypes(["slack"]), ["_synergy_slack"], "slack-only");
assertEqual(namespacesForSourceTypes(["docs"]), ["_synergy_docs"], "docs-only");
assertEqual(
  namespacesForSourceTypes(["slack", "docs"]),
  ["_synergy_slack", "_synergy_docs"],
  "all"
);
assertEqual(
  namespacesForSourceTypes(undefined),
  ["_synergy_slack", "_synergy_docs"],
  "default"
);

console.log("OK: namespace routing", {
  slackOnly: namespacesForSourceTypes(["slack"]),
  docsOnly: namespacesForSourceTypes(["docs"]),
  all: namespacesForSourceTypes(["slack", "docs"]),
});


