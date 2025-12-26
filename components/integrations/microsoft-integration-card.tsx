"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import { useProjectSelector } from "@/hooks/use-project-selector";
import { fetcher, getLocalStorage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { OneDriveIcon, ShareIcon as ShareSourceIcon } from "@/components/icons";
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
import { toast } from "sonner";
import {
  Folder,
  File as FileIcon,
  Search,
  History,
  RefreshCw,
  Loader2,
  ChevronDown,
  Info,
  Trash2,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

type MicrosoftStatus =
  | { connected: false }
  | {
      connected: true;
      accountEmail: string | null;
      tenantId: string | null;
      scopes: string[];
      expiresAt: string | null;
    };

type Item = {
  id: string;
  name: string | null;
  webUrl: string | null;
  isFolder: boolean;
  isFile: boolean;
  size: number | null;
  driveId?: string;
  parentId?: string | null;
  path?: string | null;
};

type RecentLocation = {
  driveId: string;
  folderId: string | null; // null means root
  name: string;
  timestamp: number;
};

type SyncedDoc = {
  docId: string;
  filename: string;
  documentType?: "general_doc" | "bank_statement" | "cc_statement" | "invoice";
  parseStatus?: "pending" | "parsed" | "failed" | "needs_review";
  itemId: string;
  driveId: string;
  lastSyncedAt: string;
  lastModifiedDateTime?: string;
};

type IngestDocumentType =
  | "general_doc"
  | "bank_statement"
  | "cc_statement"
  | "invoice";

const MAX_LABEL_CHARS = 200;
const SUPPORTED_FILE_EXTENSIONS = new Set(["pdf", "doc", "docx", "csv"]);

function truncateLabel(value: string, maxChars = MAX_LABEL_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

function isSupportedMicrosoftFileName(name: string | null): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === trimmed.length - 1) return false;
  const ext = trimmed.slice(lastDot + 1).toLowerCase();
  return SUPPORTED_FILE_EXTENSIONS.has(ext);
}

function filterMicrosoftItemsForDisplay(items: Item[]): Item[] {
  return items.filter((item) => item.isFolder || isSupportedMicrosoftFileName(item.name));
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function formatMicrosoftItemLocation(item: Item): { text: string; title?: string } {
  const rawTitle = item.path ?? item.webUrl ?? undefined;

  if (item.path) {
    const segments = item.path.split("/").filter(Boolean);
    const last = segments.at(-1);
    const lastDecoded = last ? safeDecodeURIComponent(last) : "";
    return { text: lastDecoded ? `…/${lastDecoded}` : "…", title: rawTitle };
  }

  if (item.webUrl) {
    try {
      const url = new URL(item.webUrl);
      const segments = url.pathname.split("/").filter(Boolean);
      const last = segments.at(-1);
      const lastDecoded = last ? safeDecodeURIComponent(last) : "";
      const suffix = lastDecoded ? `…/${lastDecoded}` : "…";
      return { text: `${url.hostname}/${suffix}`, title: rawTitle };
    } catch {
      const short = item.webUrl.length > 80 ? `${item.webUrl.slice(0, 80)}…` : item.webUrl;
      return { text: short, title: rawTitle };
    }
  }

  return { text: "", title: rawTitle };
}

export function MicrosoftIntegrationCard() {
  const { selectedProjectId } = useProjectSelector();

  const { data: status, mutate: mutateStatus, isLoading } = useSWR<MicrosoftStatus>(
    "/api/integrations/microsoft/status",
    fetcher
  );

  const [selectedDriveId, setSelectedDriveId] = useState<string | null>(null);
  const [docTypeByKey, setDocTypeByKey] = useState<Record<string, IngestDocumentType>>(
    () => ({})
  );

  const [folderStack, setFolderStack] = useState<Array<{ id: string; name: string }>>([]);
  
  const [items, setItems] = useState<Item[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [inFlightSyncKeys, setInFlightSyncKeys] = useState<Set<string>>(
    () => new Set()
  );
  const [docToRemove, setDocToRemove] = useState<SyncedDoc | null>(null);
  const [inFlightRemoveDocIds, setInFlightRemoveDocIds] = useState<Set<string>>(
    () => new Set()
  );
  
  const [sharePointUrl, setSharePointUrl] = useState("");
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Item[] | null>(null);
  
  const [recentLocations, setRecentLocations] = useState<RecentLocation[]>([]);
  const [folderSyncDialogOpen, setFolderSyncDialogOpen] = useState(false);
  const [folderSyncIsCounting, setFolderSyncIsCounting] = useState(false);
  const [folderSyncIsSyncing, setFolderSyncIsSyncing] = useState(false);
  const [folderSyncState, setFolderSyncState] = useState<{
    driveId: string;
    folderId: string;
    folderName: string;
    totalFiles: number;
  } | null>(null);

  useEffect(() => {
    // Project-scoped UI state: reset on project switch to avoid showing stale results.
    setSearchResults(null);
    setGlobalSearchQuery("");
    setSelectedDriveId(null);
    setFolderStack([]);
    setItems([]);
    setIsBusy(false);
    setInFlightSyncKeys(new Set());
    setSharePointUrl("");
    setFolderSyncDialogOpen(false);
    setFolderSyncIsCounting(false);
    setFolderSyncIsSyncing(false);
    setFolderSyncState(null);
    setDocTypeByKey({});
  }, [selectedProjectId]);

  const getTypeForKey = (key: string): IngestDocumentType =>
    docTypeByKey[key] ?? "general_doc";

  const setTypeForKey = (key: string, value: IngestDocumentType) => {
    setDocTypeByKey((prev) => ({ ...prev, [key]: value }));
  };

  const {
    data: syncedDocsData,
    mutate: mutateSyncedDocs,
    error: syncedDocsError,
  } = useSWR<{ docs: SyncedDoc[] }>(
    selectedProjectId
      ? `/api/projects/${selectedProjectId}/integrations/microsoft/sync`
      : null,
    fetcher,
    { shouldRetryOnError: false }
  );

  useEffect(() => {
    const docs = syncedDocsData?.docs;
    if (!Array.isArray(docs) || docs.length === 0) return;
    setDocTypeByKey((prev) => {
      const next: Record<string, IngestDocumentType> = { ...prev };
      for (const doc of docs) {
        const key = `${doc.driveId}:${doc.itemId}`;
        if (typeof next[key] === "string") continue;
        const stored = doc.documentType;
        next[key] = stored ?? "general_doc";
      }
      return next;
    });
  }, [syncedDocsData?.docs]);

  const connectUrl = "/api/integrations/microsoft/start?returnTo=/integrations";

  useEffect(() => {
    // Load recents on mount
    const saved = getLocalStorage("ms_recent_locations") as unknown;
    if (Array.isArray(saved)) {
      setRecentLocations(saved as RecentLocation[]);
    }
  }, []);

  const saveRecentLocation = (loc: Omit<RecentLocation, "timestamp">) => {
    const newLoc = { ...loc, timestamp: Date.now() };
    setRecentLocations((prev) => {
      // Remove duplicates (by driveId + folderId)
      const filtered = prev.filter(
        (p) => !(p.driveId === loc.driveId && p.folderId === loc.folderId)
      );
      const next = [newLoc, ...filtered].slice(0, 5); // Keep top 5
      localStorage.setItem("ms_recent_locations", JSON.stringify(next));
      return next;
    });
  };

  const loadItems = async (driveId: string, folderId: string | null) => {
    setIsBusy(true);
    try {
      const url = new URL("/api/integrations/microsoft/items", window.location.origin);
      url.searchParams.set("driveId", driveId);
      if (folderId) url.searchParams.set("itemId", folderId);
      const res = (await fetcher(url.pathname + url.search)) as { items: Item[] };
      setItems(filterMicrosoftItemsForDisplay(res.items ?? []));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to list items");
    } finally {
      setIsBusy(false);
    }
  };

  const performGlobalSearch = async () => {
    if (!globalSearchQuery.trim()) return;
    setIsBusy(true);
    setSearchResults(null);
    try {
      const res = (await fetcher(
        `/api/integrations/microsoft/search?q=${encodeURIComponent(globalSearchQuery.trim())}`
      )) as { items: Item[] };
      setSearchResults(filterMicrosoftItemsForDisplay(res.items ?? []));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Search failed");
    } finally {
      setIsBusy(false);
    }
  };

  const syncItems = async ({
    driveId,
    items,
    documentType,
  }: {
    driveId: string;
    items: Array<{ itemId: string; filename: string }>;
    documentType: IngestDocumentType;
  }) => {
    if (!selectedProjectId) {
      toast.error("Select a project first");
      return;
    }

    const keys = items.map((i) => `${driveId}:${i.itemId}`);
    const anyInFlight = keys.some((k) => inFlightSyncKeys.has(k));
    if (anyInFlight) {
      return;
    }

    setInFlightSyncKeys((prev) => {
      const next = new Set(prev);
      for (const key of keys) next.add(key);
      return next;
    });
    try {
      const res = await fetch(
        `/api/projects/${selectedProjectId}/integrations/microsoft/sync`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ driveId, items, documentType }),
        }
      );

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || "Sync failed");
      }

      const json = (await res.json()) as {
        results: Array<
          | { itemId: string; status: "synced"; docId: string; filename: string }
          | { itemId: string; status: "skipped"; reason: string }
          | { itemId: string; status: "failed"; error: string }
        >;
      };

      const syncedCount = Array.isArray(json.results)
        ? json.results.filter((r) => r.status === "synced").length
        : 0;
      const failedCount = Array.isArray(json.results)
        ? json.results.filter((r) => r.status === "failed").length
        : 0;
      const skippedCount = Array.isArray(json.results)
        ? json.results.filter((r) => r.status === "skipped").length
        : 0;
      const firstFailed = Array.isArray(json.results)
        ? json.results.find((r) => r.status === "failed")
        : null;
      const firstFailedMessage =
        firstFailed && "error" in firstFailed ? String(firstFailed.error) : null;

      if (syncedCount > 0) {
        toast.success(
          `Sync started for ${syncedCount} file(s)${
            skippedCount > 0 || failedCount > 0
              ? ` (${skippedCount} skipped, ${failedCount} failed)`
              : ""
          }`
        );
      } else if (skippedCount > 0) {
        toast.message(`Nothing to sync (${skippedCount} skipped)`);
      } else {
        toast.error(
          firstFailedMessage
            ? `Sync failed: ${firstFailedMessage}`
            : "Sync failed"
        );
      }

      await mutateSyncedDocs();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setInFlightSyncKeys((prev) => {
        const next = new Set(prev);
        for (const key of keys) next.delete(key);
        return next;
      });
    }
  };

  const removeSyncedDoc = async (doc: SyncedDoc) => {
    if (!selectedProjectId) {
      toast.error("Select a project first");
      return;
    }

    if (inFlightRemoveDocIds.has(doc.docId)) {
      return;
    }

    setInFlightRemoveDocIds((prev) => new Set(prev).add(doc.docId));
    try {
      const res = await fetch(`/api/projects/${selectedProjectId}/docs/${doc.docId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(json?.error ?? "Failed to remove file");
      }

      toast.success("Removed from context");
      await mutateSyncedDocs();
      setDocToRemove(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove file");
    } finally {
      setInFlightRemoveDocIds((prev) => {
        const next = new Set(prev);
        next.delete(doc.docId);
        return next;
      });
    }
  };

  const goToFolder = async (driveId: string, folderId: string, name: string) => {
    // When navigating manually, clear search mode
    setSearchResults(null);
    setGlobalSearchQuery("");
    
    setSelectedDriveId(driveId);
    setFolderStack([...folderStack, { id: folderId, name }]);
    await loadItems(driveId, folderId);
    
    // Save to recents
    saveRecentLocation({ driveId, folderId, name });
  };

  const openFolderSyncDialog = async ({
    driveId,
    folderId,
    folderName,
  }: {
    driveId: string;
    folderId: string;
    folderName: string;
  }) => {
    if (!selectedProjectId) {
      toast.error("Select a project first");
      return;
    }

    setFolderSyncDialogOpen(true);
    setFolderSyncState({
      driveId,
      folderId,
      folderName,
      totalFiles: 0,
    });
    setFolderSyncIsCounting(true);
    try {
      const res = await fetch(
        `/api/projects/${selectedProjectId}/integrations/microsoft/sync-folder`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ driveId, folderId, dryRun: true }),
        }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || "Failed to count folder files");
      }
      const json = (await res.json()) as { totalFiles: number };
      setFolderSyncState((prev) =>
        prev
          ? {
              ...prev,
              totalFiles:
                typeof json.totalFiles === "number" ? json.totalFiles : prev.totalFiles,
            }
          : prev
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to inspect folder");
      setFolderSyncDialogOpen(false);
    } finally {
      setFolderSyncIsCounting(false);
    }
  };

  const syncFolder = async () => {
    if (!selectedProjectId) {
      toast.error("Select a project first");
      return;
    }
    if (!folderSyncState) return;

    setFolderSyncIsSyncing(true);
    try {
      const folderKey = `${folderSyncState.driveId}:${folderSyncState.folderId}`;
      const documentType = getTypeForKey(folderKey);
      const res = await fetch(
        `/api/projects/${selectedProjectId}/integrations/microsoft/sync-folder`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            driveId: folderSyncState.driveId,
            folderId: folderSyncState.folderId,
            documentType,
          }),
        }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || "Folder sync failed");
      }

      const json = (await res.json()) as {
        totalFiles: number;
        synced: number;
        skipped: number;
        failed: number;
      };

      toast.success(
        `Synced ${json.synced} file(s) (${json.skipped} skipped, ${json.failed} failed)`
      );
      await mutateSyncedDocs();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Folder sync failed");
    } finally {
      setFolderSyncIsSyncing(false);
      setFolderSyncDialogOpen(false);
      setFolderSyncState(null);
    }
  };

  const restoreRecent = async (loc: RecentLocation) => {
    setSearchResults(null);
    setGlobalSearchQuery("");
    
    setSelectedDriveId(loc.driveId);
    // We can't easily reconstruct the full folder stack names without fetching, 
    // so we just set the stack to the target folder.
    // Ideally we'd fetch parent chain but that's expensive.
    setFolderStack(loc.folderId ? [{ id: loc.folderId, name: loc.name }] : []);
    
    await loadItems(loc.driveId, loc.folderId);
    toast.success(`Restored: ${loc.name}`);
  };

  const goBackTo = async (driveId: string, index: number) => {
    const next = folderStack.slice(0, index + 1);
    setFolderStack(next);
    const id = next.at(-1)?.id ?? null;
    await loadItems(driveId, id);
  };

  const jumpToSharePointUrl = async () => {
    if (!sharePointUrl || sharePointUrl.trim().length === 0) {
      toast.error("Paste a SharePoint folder/file URL first");
      return;
    }

    setIsBusy(true);
    setSearchResults(null);
    try {
      const res = (await fetcher(
        `/api/integrations/microsoft/resolve?url=${encodeURIComponent(sharePointUrl.trim())}`
      )) as {
        driveId: string;
        item: {
          id: string;
          name: string | null;
          isFolder: boolean;
          isFile: boolean;
          parentId: string | null;
        };
      };

      setSelectedDriveId(res.driveId);

      // If it's a folder, browse it; if it's a file, browse its parent and preselect it.
      if (res.item.isFolder) {
        setFolderStack([{ id: res.item.id, name: res.item.name ?? "Folder" }]);
        await loadItems(res.driveId, res.item.id);
        saveRecentLocation({ driveId: res.driveId, folderId: res.item.id, name: res.item.name ?? "Folder" });
        toast.success("Opened folder");
        setSharePointUrl(""); // clear input on success
        return;
      }

      if (!isSupportedMicrosoftFileName(res.item.name)) {
        toast.error("Only PDF or Word documents (.pdf, .doc, .docx) are supported.");
        return;
      }

      const parentId = res.item.parentId;
      setFolderStack([]); // We don't know the parent name easily, so reset stack or fetch it? Reset is safer.
      await loadItems(res.driveId, parentId);
      toast.success("Opened file location");
      setSharePointUrl("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to resolve SharePoint URL");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="text-onedrive" title="SharePoint / Teams / OneDrive">
              <OneDriveIcon size={16} />
            </span>
            <span>Microsoft (SharePoint / Teams / OneDrive)</span>
          </div>
          <div className="text-xs text-muted-foreground">
            Connect to SharePoint/Teams/OneDrive and import PDF/DOCX files.
          </div>
        </div>

        {!status?.connected ? (
          <Button asChild disabled={isLoading} type="button">
            <a href={connectUrl}>Connect</a>
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button
              onClick={async () => {
                try {
                  const res = await fetch("/api/integrations/microsoft/disconnect", {
                    method: "DELETE",
                  });
                  if (!res.ok) {
                    throw new Error("Failed to disconnect");
                  }
                  toast.success("Disconnected from Microsoft");
                  void mutateStatus();
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Failed to disconnect");
                }
              }}
              type="button"
              variant="outline"
            >
              Disconnect
            </Button>
            <Button
              onClick={() => void mutateStatus()}
              type="button"
              variant="outline"
            >
              Refresh
            </Button>
          </div>
        )}
      </div>

      {status?.connected && (
        <div className="mt-3 text-xs text-muted-foreground">
          Connected as {status.accountEmail ?? "Unknown account"}
        </div>
      )}

      {status?.connected && (
        <div className="mt-6 space-y-6">
          {/* 1. Global Search (Primary) */}
          <div className="space-y-2">
            <div className="text-sm font-medium flex items-center gap-2">
              <Search className="h-4 w-4" />
              Find Files (Global Search)
            </div>
            <div className="flex gap-2">
              <Input
                className="flex-1"
                onChange={(e) => setGlobalSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void performGlobalSearch();
                  }
                }}
                placeholder="Search for files (e.g., 'EPC Specs')..."
                value={globalSearchQuery}
              />
              <Button disabled={isBusy} onClick={() => void performGlobalSearch()} type="button">
                Search
              </Button>
            </div>

            {!selectedProjectId && (
              <div className="text-xs text-muted-foreground">
                Select a project to enable Sync.
              </div>
            )}
          </div>

          {/* Paste Link */}
          <Collapsible className="space-y-2">
            <CollapsibleTrigger asChild>
              <Button
                className="group h-auto justify-between px-0 py-0 text-xs font-medium"
                type="button"
                variant="ghost"
              >
                <span>Or paste a SharePoint link</span>
                <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2">
              <div className="flex items-end gap-2">
                <Input
                  className="flex-1"
                  onChange={(e) => setSharePointUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void jumpToSharePointUrl();
                    }
                  }}
                  placeholder="https://company.sharepoint.com/sites/..."
                  value={sharePointUrl}
                />
                <Button
                  disabled={isBusy}
                  onClick={() => void jumpToSharePointUrl()}
                  type="button"
                  variant="secondary"
                >
                  Open
                </Button>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Synced files (table) */}
          {selectedProjectId && (syncedDocsData?.docs ?? []).length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium flex items-center gap-2">
                  <History className="h-4 w-4" />
                  Synced files
                </div>
                <Button
                  disabled={isBusy}
                  onClick={() => void mutateSyncedDocs()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>

              <div className="rounded-md border overflow-hidden">
                <div className="grid grid-cols-[24px_1fr_160px_220px_170px] gap-3 px-3 py-2 text-xs text-muted-foreground border-b">
                  <div>Src</div>
                  <div>Name</div>
                  <div>Type</div>
                  <div>Last synced</div>
                  <div />
                </div>
                <div className="divide-y">
                  {(syncedDocsData?.docs ?? []).map((doc) => {
                    const syncKey = `${doc.driveId}:${doc.itemId}`;
                    const isSyncing = inFlightSyncKeys.has(syncKey);
                    const isRemoving = inFlightRemoveDocIds.has(doc.docId);
                    const displayName = truncateLabel(doc.filename);
                    const selectedType = getTypeForKey(syncKey);
                    return (
                      <div
                        className="grid grid-cols-[24px_1fr_160px_220px_170px] items-center gap-3 px-3 py-2 text-xs"
                        key={doc.docId}
                      >
                        <div className="flex items-center justify-center">
                          <ShareSourceIcon size={14} />
                        </div>
                        <div className="min-w-0 truncate" title={doc.filename}>
                          {displayName}
                        </div>
                        <div className="min-w-0 truncate text-muted-foreground">
                          {(doc.documentType ?? "general_doc") +
                            (doc.parseStatus ? ` · ${doc.parseStatus}` : "")}
                        </div>
                        <div className="truncate text-muted-foreground">
                          {new Date(doc.lastSyncedAt).toLocaleString()}
                        </div>
                        <div className="flex items-center justify-end gap-1">
                          <Select
                            onValueChange={(value) => {
                              const v = value as IngestDocumentType;
                              setTypeForKey(syncKey, v);
                              void syncItems({
                                driveId: doc.driveId,
                                items: [{ itemId: doc.itemId, filename: doc.filename }],
                                documentType: v,
                              });
                            }}
                            value={selectedType}
                          >
                            <SelectTrigger
                              className="h-8 w-[190px] text-xs"
                              disabled={isSyncing}
                            >
                              <SelectValue placeholder="Sync as…" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="general_doc">Sync as normal doc</SelectItem>
                              <SelectItem value="bank_statement">Sync as bank statement</SelectItem>
                              <SelectItem value="cc_statement">Sync as cc statement</SelectItem>
                              <SelectItem value="invoice">Sync as invoice</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            aria-label="Remove from context"
                            disabled={isRemoving}
                            onClick={() => setDocToRemove(doc)}
                            size="icon"
                            title="Remove from context"
                            type="button"
                            variant="ghost"
                            className="h-8 w-8"
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                          
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Search results */}
          {searchResults && (
            <div className="rounded-md border p-2">
              <div className="text-xs font-medium text-muted-foreground mb-2 px-2">
                {searchResults.length} results found
              </div>
              <ScrollArea className="h-64">
                <div className="divide-y">
                  {searchResults.map((item) => {
                    const driveId = item.driveId;
                    const label = item.name ?? item.id;
                    const location = formatMicrosoftItemLocation(item);
                    const syncKey = driveId ? `${driveId}:${item.id}` : null;
                    const isSyncing = syncKey ? inFlightSyncKeys.has(syncKey) : false;
                    const selectedType = syncKey ? getTypeForKey(syncKey) : "general_doc";
                    const onActivate = () => {
                      if (!driveId) return;
                      if (item.isFolder) {
                        void openFolderSyncDialog({
                          driveId,
                          folderId: item.id,
                          folderName: label,
                        });
                        return;
                      }
                      void syncItems({
                        driveId,
                        items: [{ itemId: item.id, filename: label }],
                        documentType: selectedType,
                      });
                    };

                    return (
                      <div
                        className="flex w-full items-center justify-between gap-3 rounded-sm p-2 hover:bg-accent cursor-pointer"
                        key={item.id}
                        onClick={onActivate}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onActivate();
                          }
                        }}
                        role="button"
                        tabIndex={0}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium flex items-center gap-2">
                            {item.isFolder ? (
                              <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
                            ) : (
                              <FileIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                            )}
                            <span className="max-w-[250px] truncate" title={label}>
                              {label}
                            </span>
                          </div>
                          {location.text ? (
                            <div
                              className="truncate text-xs text-muted-foreground"
                              title={location.title}
                            >
                              {location.text}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {item.isFolder ? (
                            <>
                              <Button
                                disabled={isBusy || !item.driveId}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!item.driveId) return;
                                  void goToFolder(item.driveId, item.id, label);
                                }}
                                size="sm"
                                type="button"
                                variant="ghost"
                                className="shrink-0 whitespace-nowrap"
                              >
                                Open
                              </Button>
                              <Button
                                disabled={isBusy || !item.driveId}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!item.driveId) return;
                                  void openFolderSyncDialog({
                                    driveId: item.driveId,
                                    folderId: item.id,
                                    folderName: label,
                                  });
                                }}
                                size="sm"
                                type="button"
                                variant="outline"
                                className="shrink-0 whitespace-nowrap"
                              >
                                Sync
                              </Button>
                            </>
                          ) : syncKey ? (
                            <Select
                              onValueChange={(value) => {
                                const v = value as IngestDocumentType;
                                setTypeForKey(syncKey, v);
                                if (!item.driveId) return;
                                void syncItems({
                                  driveId: item.driveId,
                                  items: [{ itemId: item.id, filename: label }],
                                  documentType: v,
                                });
                              }}
                              value={selectedType}
                            >
                              <SelectTrigger
                                className="h-8 w-[190px] text-xs"
                                disabled={isSyncing || !item.driveId || !selectedProjectId}
                              >
                                <SelectValue placeholder="Sync as…" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="general_doc">Sync as general doc</SelectItem>
                                <SelectItem value="bank_statement">Sync as bank statement</SelectItem>
                                <SelectItem value="cc_statement">Sync as cc statement</SelectItem>
                                <SelectItem value="invoice">Sync as invoice</SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            <Button
                              disabled={true}
                              size="sm"
                              type="button"
                              className="shrink-0 whitespace-nowrap"
                            >
                              Sync
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {searchResults.length === 0 && (
                    <div className="p-4 text-center text-sm text-muted-foreground">
                      No matches found.
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          )}

          {/* Recent Locations */}
          {recentLocations.length > 0 && !searchResults && (
            <div className="space-y-2">
              <div className="text-sm font-medium flex items-center gap-2">
                <History className="h-4 w-4" />
                Recent Locations
              </div>
              <div className="flex flex-wrap gap-2">
                {recentLocations.map((loc) => (
                  <Button
                    key={`${loc.driveId}-${loc.folderId}`}
                    onClick={() => void restoreRecent(loc)}
                    size="sm"
                    variant="outline"
                    className="gap-2"
                  >
                    <Folder className="h-3 w-3" />
                    {loc.name}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* 4. Active File Browser (Standard View) */}
          {selectedDriveId && !searchResults && (
            <div className="rounded-md border p-4 space-y-4 bg-muted/10">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium">Browsing: {folderStack.at(-1)?.name ?? "Root"}</div>
              </div>

              {folderStack.length > 0 && (
                <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                  <Button
                    onClick={() => {
                      setFolderStack([]);
                      void loadItems(selectedDriveId, null);
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Root
                  </Button>
                  {folderStack.map((f, idx) => (
                    <Button
                      key={f.id}
                      onClick={() => void goBackTo(selectedDriveId, idx)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      / {f.name}
                    </Button>
                  ))}
                </div>
              )}

              <ScrollArea className="h-64 rounded-md border bg-background">
                <div className="divide-y">
                  {filterMicrosoftItemsForDisplay(items).map((item) => {
                    const label = item.name ?? item.id;
                    const displayLabel = truncateLabel(label);
                    const syncKey = `${selectedDriveId}:${item.id}`;
                    const isSyncing = inFlightSyncKeys.has(syncKey);
                    return (
                      <div className="flex w-full items-center justify-between gap-3 p-2" key={item.id}>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm flex items-center gap-2" title={label}>
                            {item.isFolder ? (
                              <Folder className="h-3 w-3 text-muted-foreground" />
                            ) : (
                              <FileIcon className="h-3 w-3 text-muted-foreground" />
                            )}
                            {displayLabel}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {item.isFolder ? (
                            <>
                              <Button
                                onClick={() =>
                                  void openFolderSyncDialog({
                                    driveId: selectedDriveId,
                                    folderId: item.id,
                                    folderName: label,
                                  })
                                }
                                size="sm"
                                type="button"
                                variant="outline"
                                className="shrink-0 whitespace-nowrap"
                              >
                                Sync
                              </Button>
                              <Button
                                onClick={() => void goToFolder(selectedDriveId, item.id, label)}
                                size="sm"
                                type="button"
                                variant="ghost"
                                className="shrink-0 whitespace-nowrap"
                              >
                                Open
                              </Button>
                            </>
                          ) : (
                            <Select
                              onValueChange={(value) => {
                                const v = value as IngestDocumentType;
                                setTypeForKey(syncKey, v);
                                void syncItems({
                                  driveId: selectedDriveId,
                                  items: [{ itemId: item.id, filename: label }],
                                  documentType: v,
                                });
                              }}
                              value={getTypeForKey(syncKey)}
                            >
                              <SelectTrigger
                                className="h-8 w-[190px] text-xs"
                                disabled={isSyncing || !selectedProjectId}
                              >
                                <SelectValue placeholder="Sync as…" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="general_doc">Sync as general doc</SelectItem>
                                <SelectItem value="bank_statement">Sync as bank statement</SelectItem>
                                <SelectItem value="cc_statement">Sync as cc statement</SelectItem>
                                <SelectItem value="invoice">Sync as invoice</SelectItem>
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {items.length === 0 && (
                    <div className="p-3 text-sm text-muted-foreground">
                      No items found.
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          )}

        </div>
      )}

      <AlertDialog open={docToRemove !== null} onOpenChange={(open) => !open && setDocToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from context?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the file from Flowchat context and delete its stored
              copy and indexed content. This does not delete the file in
              SharePoint/OneDrive.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={docToRemove ? inFlightRemoveDocIds.has(docToRemove.docId) : false} type="button">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={docToRemove ? inFlightRemoveDocIds.has(docToRemove.docId) : true}
              onClick={() => {
                if (docToRemove) {
                  void removeSyncedDoc(docToRemove);
                }
              }}
              type="button"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={folderSyncDialogOpen} onOpenChange={setFolderSyncDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sync folder?</AlertDialogTitle>
            <AlertDialogDescription>
              {folderSyncIsCounting
                ? "Counting files in this folder…"
                : folderSyncState
                  ? `Are you sure you'd like to sync ${folderSyncState.totalFiles} file(s) from "${folderSyncState.folderName}"?`
                  : "Preparing folder sync…"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {folderSyncState ? (
            <div className="mt-3">
              <div className="mb-1 text-xs text-muted-foreground">Sync as</div>
              <Select
                onValueChange={(value) => {
                  const key = `${folderSyncState.driveId}:${folderSyncState.folderId}`;
                  setTypeForKey(key, value as IngestDocumentType);
                }}
                value={getTypeForKey(`${folderSyncState.driveId}:${folderSyncState.folderId}`)}
              >
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="general_doc">General doc</SelectItem>
                  <SelectItem value="bank_statement">Bank statement</SelectItem>
                  <SelectItem value="cc_statement">CC statement</SelectItem>
                  <SelectItem value="invoice">Invoice</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={folderSyncIsSyncing} type="button">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={folderSyncIsCounting || folderSyncIsSyncing || !folderSyncState}
              onClick={() => void syncFolder()}
              type="button"
            >
              {folderSyncIsSyncing ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Syncing
                </span>
              ) : (
                "Sync"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
