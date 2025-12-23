"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { fetcher } from "@/lib/utils";

type NamespacesResponse = { namespaces: string[] };
type DocsRow = {
  id: string;
  indexedAtMs?: number;
  sourceCreatedAtMs?: number;
  doc_id?: string;
  filename?: string;
  source_url?: string | null;
  mime_type?: string;
  chunk_index?: number;
};
type DocsResponse = { rows: DocsRow[] };
type SlackRow = {
  id: string;
  ts?: string;
  content?: string;
  sourceCreatedAtMs?: number;
  indexedAtMs?: number;
  channel_name?: string;
  user_name?: string;
  url?: string;
};
type SlackResponse = { rows: SlackRow[] };
type ApiErrorResponse = { code?: string; message?: string; cause?: string };

export function TurbopufferAdmin() {
  const { data, error, isLoading, mutate } = useSWR<NamespacesResponse>(
    "/api/admin/turbopuffer/namespaces",
    fetcher,
    { shouldRetryOnError: false }
  );

  const [query, setQuery] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectedNamespace, setSelectedNamespace] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const [docsOpenFor, setDocsOpenFor] = useState<string | null>(null);
  const [docsByNamespace, setDocsByNamespace] = useState<Record<string, DocsRow[]>>(
    {}
  );
  const [docsLoadingFor, setDocsLoadingFor] = useState<string | null>(null);

  const [slackOpenFor, setSlackOpenFor] = useState<string | null>(null);
  const [slackByNamespace, setSlackByNamespace] = useState<Record<string, SlackRow[]>>(
    {}
  );
  const [slackLoadingFor, setSlackLoadingFor] = useState<string | null>(null);

  const namespaces = data?.namespaces ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return namespaces;
    return namespaces.filter((n) => n.toLowerCase().includes(q));
  }, [namespaces, query]);

  const openDelete = (ns: string) => {
    setSelectedNamespace(ns);
    setConfirmOpen(true);
  };

  const doDelete = async () => {
    if (!selectedNamespace) return;
    setIsDeleting(true);
    try {
      const res = await fetch("/api/admin/turbopuffer/namespaces/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ namespace: selectedNamespace }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as ApiErrorResponse | null;
        throw new Error(json?.cause ?? json?.message ?? "Delete failed");
      }
      toast.success("Namespace deleted");
      setConfirmOpen(false);
      setSelectedNamespace(null);
      void mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete namespace");
    } finally {
      setIsDeleting(false);
    }
  };

  const formatMs = (ms: number | undefined) => {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
    return new Date(ms).toLocaleString();
  };

  const previewText = (text: string | undefined, limit: number) => {
    if (!text) return "—";
    const trimmed = text.trim();
    if (trimmed.length <= limit) return trimmed;
    return `${trimmed.slice(0, limit)}…`;
  };

  const loadDocs = async (ns: string) => {
    setDocsOpenFor(ns);
    setSlackOpenFor(null);
    setDocsLoadingFor(ns);
    try {
      const res = await fetch("/api/admin/turbopuffer/namespaces/docs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ namespace: ns }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as ApiErrorResponse | null;
        throw new Error(json?.cause ?? json?.message ?? "Failed to load docs");
      }
      const json = (await res.json()) as DocsResponse;
      setDocsByNamespace((prev) => ({ ...prev, [ns]: json.rows ?? [] }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load docs");
    } finally {
      setDocsLoadingFor(null);
    }
  };

  const loadSlack = async (ns: string) => {
    setSlackOpenFor(ns);
    setDocsOpenFor(null);
    setSlackLoadingFor(ns);
    try {
      const res = await fetch("/api/admin/turbopuffer/namespaces/slack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ namespace: ns }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as ApiErrorResponse | null;
        throw new Error(json?.cause ?? json?.message ?? "Failed to load slack rows");
      }
      const json = (await res.json()) as SlackResponse;
      setSlackByNamespace((prev) => ({ ...prev, [ns]: json.rows ?? [] }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load slack rows");
    } finally {
      setSlackLoadingFor(null);
    }
  };

  return (
    <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium">Namespaces</div>
          <Button
            disabled={isLoading}
            onClick={() => void mutate()}
            type="button"
            variant="outline"
          >
            Refresh
          </Button>
        </div>

        <Input
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter namespaces…"
          value={query}
        />

        {error ? (
          <div className="text-sm text-muted-foreground">
            Failed to load namespaces{error instanceof Error ? `: ${error.message}` : "."}
          </div>
        ) : isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="text-sm text-muted-foreground">No namespaces found.</div>
        ) : (
          <ScrollArea className="h-[420px]">
            <div className="space-y-2 pr-3">
              {filtered.map((ns) => (
                <div
                  className="rounded-md border px-3 py-2"
                  key={ns}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1 truncate font-mono text-xs" title={ns}>
                      {ns}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        disabled={docsLoadingFor === ns}
                        onClick={() => void loadDocs(ns)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {docsLoadingFor === ns ? "Loading…" : "List docs"}
                      </Button>
                      <Button
                        disabled={slackLoadingFor === ns}
                        onClick={() => void loadSlack(ns)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {slackLoadingFor === ns ? "Loading…" : "List slack"}
                      </Button>
                      <Button
                        onClick={() => openDelete(ns)}
                        size="sm"
                        type="button"
                        variant="destructive"
                      >
                        Delete
                      </Button>
                    </div>
                  </div>

                  {docsOpenFor === ns ? (
                    <div className="mt-3 rounded-md border bg-muted/30 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="text-xs font-medium">Most recent 25 docs</div>
                        <Button
                          onClick={() => setDocsOpenFor(null)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Close
                        </Button>
                      </div>

                      {(docsByNamespace[ns] ?? []).length === 0 ? (
                        <div className="text-xs text-muted-foreground">
                          No docs rows found in this namespace.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {(docsByNamespace[ns] ?? []).map((row) => (
                            <div className="rounded border bg-background p-2" key={row.id}>
                              <div className="flex flex-col gap-1">
                                <div className="truncate font-mono text-[11px]" title={row.id}>
                                  {row.id}
                                </div>
                                <div className="text-xs">
                                  <span className="font-medium">
                                    {row.filename ?? row.doc_id ?? "—"}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {row.chunk_index !== undefined
                                      ? ` · chunk ${String(row.chunk_index)}`
                                      : ""}
                                    {row.mime_type ? ` · ${row.mime_type}` : ""}
                                  </span>
                                </div>
                                <div className="text-[11px] text-muted-foreground">
                                  indexed: {formatMs(row.indexedAtMs)} · source:{" "}
                                  {formatMs(row.sourceCreatedAtMs)}
                                </div>
                                {row.source_url ? (
                                  <div
                                    className="truncate font-mono text-[11px] text-muted-foreground"
                                    title={row.source_url}
                                  >
                                    {row.source_url}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}

                  {slackOpenFor === ns ? (
                    <div className="mt-3 rounded-md border bg-muted/30 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="text-xs font-medium">Most recent 25 slack rows</div>
                        <Button
                          onClick={() => setSlackOpenFor(null)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Close
                        </Button>
                      </div>

                      {(slackByNamespace[ns] ?? []).length === 0 ? (
                        <div className="text-xs text-muted-foreground">
                          No slack rows found in this namespace.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {(slackByNamespace[ns] ?? []).map((row) => (
                            <div className="rounded border bg-background p-2" key={row.id}>
                              <div className="flex flex-col gap-1">
                                <div className="flex items-center justify-between gap-2">
                                  <div
                                    className="min-w-0 flex-1 truncate font-mono text-[11px]"
                                    title={row.id}
                                  >
                                    {row.id}
                                  </div>
                                  <div className="font-mono text-[11px] text-muted-foreground">
                                    {row.ts ?? "—"}
                                  </div>
                                </div>
                                <div className="text-xs">
                                  <span className="font-medium">
                                    {row.channel_name ? `#${row.channel_name}` : "—"}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {row.user_name ? ` · ${row.user_name}` : ""}
                                  </span>
                                </div>
                                <div className="whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
                                  {previewText(row.content, 255)}
                                </div>
                                <div className="text-[11px] text-muted-foreground">
                                  source: {formatMs(row.sourceCreatedAtMs)} · indexed:{" "}
                                  {formatMs(row.indexedAtMs)}
                                </div>
                                {row.url ? (
                                  <div
                                    className="truncate font-mono text-[11px] text-muted-foreground"
                                    title={row.url}
                                  >
                                    {row.url}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      <AlertDialog
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) setSelectedNamespace(null);
        }}
        open={confirmOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete namespace?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes all vectors in:
              <span className="mt-2 block break-all font-mono text-xs">
                {selectedNamespace ?? "—"}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={isDeleting} onClick={doDelete}>
              {isDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}


