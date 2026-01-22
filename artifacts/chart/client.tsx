"use client";

import { Artifact } from "@/components/create-artifact";
import { ChartViewer, safeParseChartPayload } from "@/components/chart-viewer";

export const chartArtifact = new Artifact<"chart", null>({
  kind: "chart",
  description: "Useful for interactive charts",
  initialize: () => null,
  onStreamPart: () => {
    // Chart documents are currently not streamed; they are saved and then rendered from stored content.
  },
  content: ({ content, isLoading }) => {
    if (isLoading) {
      return (
        <div className="mx-auto w-full max-w-3xl p-6">
          <div className="h-4 w-40 animate-pulse rounded bg-muted-foreground/20" />
          <div className="mt-4 h-[220px] w-[220px] animate-pulse rounded-full bg-muted-foreground/20" />
        </div>
      );
    }

    const payload = safeParseChartPayload(content);
    if (!payload) {
      return (
        <div className="mx-auto w-full max-w-3xl p-6">
          <div className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">
            Unable to render chart (invalid payload).
          </div>
        </div>
      );
    }

    return <ChartViewer payload={payload} />;
  },
  actions: [],
  toolbar: [],
});

