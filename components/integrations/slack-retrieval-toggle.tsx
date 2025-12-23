"use client";

import { useId } from "react";
import { useRetrievalSettings } from "@/hooks/use-retrieval-settings";

export function SlackRetrievalToggle() {
  const { includeSlack, setIncludeSlack } = useRetrievalSettings();
  const id = useId();

  return (
    <div className="mt-6 rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex items-start gap-3">
        <input
          checked={includeSlack}
          className="mt-0.5 h-4 w-4"
          id={id}
          onChange={(event) => setIncludeSlack(event.target.checked)}
          type="checkbox"
        />
        <div className="min-w-0">
          <label className="text-sm font-medium" htmlFor={id}>
            Use Slack in chat context
          </label>
          <p className="text-sm text-muted-foreground">
            When enabled, chats can retrieve relevant Slack messages.
          </p>
        </div>
      </div>
    </div>
  );
}


