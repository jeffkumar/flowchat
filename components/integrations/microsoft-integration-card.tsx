"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import { useProjectSelector } from "@/hooks/use-project-selector";
import { fetcher, getLocalStorage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  Pencil,
  Trash2,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";

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
  url?: string | null;
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

function formatDocType(value: IngestDocumentType) {
  if (value === "bank_statement") return "Bank statement";
  if (value === "cc_statement") return "CC statement";
  if (value === "invoice") return "Invoice";
  return "General doc";
}

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

type DisplayStatus =
  | { label: "Processing"; detail?: string; isProcessing: true }
  | { label: "Failed"; detail?: string; isProcessing: false }
  | { label: "Synced"; detail?: string; isProcessing: false };

function getDisplayStatus({
  parseStatus,
  isSyncing,
}: {
  parseStatus: SyncedDoc["parseStatus"] | undefined;
  isSyncing: boolean;
}): DisplayStatus {
  if (isSyncing || parseStatus === "pending") {
    return { label: "Processing", isProcessing: true };
  }
  if (parseStatus === "failed") {
    return { label: "Failed", isProcessing: false };
  }
  if (parseStatus === "needs_review") {
    return { label: "Synced", detail: "Needs review", isProcessing: false };
  }
  if (parseStatus === "parsed") {
    return { label: "Synced", isProcessing: false };
  }
  return { label: "Synced", isProcessing: false };
}

type InvoiceParties = { senders: string[]; recipients: string[] };

import { BusinessNameTypeahead } from "@/components/business-name-typeahead";

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

  const [invoiceSender, setInvoiceSender] = useState(() => {
    const v = getLocalStorage("invoice_sender_last") as unknown;
    return typeof v === "string" ? v : "";
  });
  const [invoiceRecipient, setInvoiceRecipient] = useState(() => {
    const v = getLocalStorage("invoice_recipient_last") as unknown;
    return typeof v === "string" ? v : "";
  });
  const [invoiceSyncDialog, setInvoiceSyncDialog] = useState<{
    driveId: string;
    items: Array<{ itemId: string; filename: string }>;
  } | null>(null);

  const [importDialog, setImportDialog] = useState<{
    driveId: string;
    items: Array<{ itemId: string; filename: string }>;
    documentType: IngestDocumentType;
  } | null>(null);
  const [importEntityKind, setImportEntityKind] = useState<"personal" | "business">(
    "personal"
  );
  const [importBusinessName, setImportBusinessName] = useState("");

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
    setDocTypeByKey({});
  }, [selectedProjectId]);

  useEffect(() => {
    localStorage.setItem("invoice_sender_last", invoiceSender);
  }, [invoiceSender]);

  useEffect(() => {
    localStorage.setItem("invoice_recipient_last", invoiceRecipient);
  }, [invoiceRecipient]);

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

  const { data: invoiceParties } = useSWR<InvoiceParties>(
    selectedProjectId ? `/api/projects/${selectedProjectId}/invoices/parties` : null,
    fetcher
  );

  const { data: businessNamesData } = useSWR<{ names: string[] }>(
    "/api/entities/business-names",
    fetcher,
    { shouldRetryOnError: false }
  );

  const syncedDocByKey = (syncedDocsData?.docs ?? []).reduce<Record<string, SyncedDoc>>(
    (acc, doc) => {
      acc[`${doc.driveId}:${doc.itemId}`] = doc;
      return acc;
    },
    {}
  );

  const isTypeLocked = (syncKey: string) => Boolean(syncedDocByKey[syncKey]);

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

  const importItems = async ({
    driveId,
    items,
    documentType,
    entityKind,
    entityName,
    invoiceSender,
    invoiceRecipient,
  }: {
    driveId: string;
    items: Array<{ itemId: string; filename: string }>;
    documentType: IngestDocumentType;
    entityKind: "personal" | "business";
    entityName: string;
    invoiceSender?: string;
    invoiceRecipient?: string;
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

    if (selectedProjectId) {
      const nowIso = new Date().toISOString();
      const optimisticDocs: SyncedDoc[] = (syncedDocsData?.docs ?? []).slice();
      for (const item of items) {
        const syncKey = `${driveId}:${item.itemId}`;
        const existing = syncedDocByKey[syncKey];
        if (existing) {
          const idx = optimisticDocs.findIndex((d) => d.docId === existing.docId);
          if (idx >= 0) {
            optimisticDocs[idx] = {
              ...existing,
              filename: item.filename,
              documentType,
              parseStatus: "pending",
              lastSyncedAt: nowIso,
            };
          }
        } else {
          optimisticDocs.unshift({
            docId: `optimistic:${driveId}:${item.itemId}`,
            filename: item.filename,
            url: null,
            documentType,
            parseStatus: "pending",
            itemId: item.itemId,
            driveId,
            lastSyncedAt: nowIso,
          });
        }
      }

      await mutateSyncedDocs({ docs: optimisticDocs }, { revalidate: false });
    }
    try {
      const trimmedEntityName = entityName.trim();
      const sender =
        documentType === "invoice" && typeof invoiceSender === "string"
          ? invoiceSender.trim()
          : "";
      const recipient =
        documentType === "invoice" && typeof invoiceRecipient === "string"
          ? invoiceRecipient.trim()
          : "";
      const res = await fetch(
        `/api/projects/${selectedProjectId}/integrations/microsoft/sync`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            driveId,
            items,
            documentType,
            entityName: trimmedEntityName,
            entityKind,
            invoiceSender: sender.length > 0 ? sender : undefined,
            invoiceRecipient: recipient.length > 0 ? recipient : undefined,
          }),
        }
      );

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || "Import failed");
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
          `Import completed for ${syncedCount} file(s)${
            skippedCount > 0 || failedCount > 0
              ? ` (${skippedCount} skipped, ${failedCount} failed)`
              : ""
          }`
        );
      } else if (skippedCount > 0) {
        toast.message(`Nothing to import (${skippedCount} skipped)`);
      } else {
        toast.error(
          firstFailedMessage
            ? `Import failed: ${firstFailedMessage}`
            : "Import failed"
        );
      }

      await mutateSyncedDocs();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Import failed");
      await mutateSyncedDocs();
    } finally {
      setInFlightSyncKeys((prev) => {
        const next = new Set(prev);
        for (const key of keys) next.delete(key);
        return next;
      });
    }
  };

  const requestImport = ({
    driveId,
    items,
    documentType,
  }: {
    driveId: string;
    items: Array<{ itemId: string; filename: string }>;
    documentType: IngestDocumentType;
  }) => {
    setImportEntityKind("personal");
    setImportBusinessName("");
    if (documentType === "invoice") {
      setInvoiceSyncDialog({ driveId, items });
      return;
    }
    setImportDialog({ driveId, items, documentType });
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
            <span>Microsoft (SharePoint / OneDrive)</span>
          </div>  
          {status?.connected && (
            <div className="mt-3 text-xs text-muted-foreground">
              Connected as {status.accountEmail ?? "Unknown account"}
            </div>
          )}
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
              <Button
                disabled={isBusy || !globalSearchQuery.trim()}
                onClick={() => void performGlobalSearch()}
                type="button"
              >
                {isBusy && globalSearchQuery.trim() ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Searching…
                  </>
                ) : (
                  "Search"
                )}
              </Button>
              {searchResults ? (
                <Button
                  disabled={isBusy}
                  onClick={() => {
                    setSearchResults(null);
                    setGlobalSearchQuery("");
                  }}
                  type="button"
                  variant="outline"
                >
                  Clear
                </Button>
              ) : null}
            </div>

            {!selectedProjectId && (
              <div className="text-xs text-muted-foreground">
                Select a project to enable Import.
              </div>
            )}
          </div>

          {/* Other options */}
          <Collapsible className="space-y-2">
            <CollapsibleTrigger asChild>
              <Button
                className="group h-auto justify-between px-0 py-0 text-xs font-medium"
                type="button"
                variant="ghost"
              >
                <span>Other options</span>
                <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                Paste a SharePoint link
              </div>
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

          {/* Search results */}
          {searchResults && (
            <div className="rounded-md border p-2">
              <div className="text-xs font-medium text-muted-foreground mb-2 px-2">
                {searchResults.length} results found
              </div>
              <div className="max-h-[260px] overflow-y-auto">
                <div className="divide-y">
                  {searchResults.map((item) => {
                    const driveId = item.driveId;
                    const label = item.name ?? item.id;
                    const location = formatMicrosoftItemLocation(item);
                    const syncKey = driveId ? `${driveId}:${item.id}` : null;
                    const isSyncing = syncKey ? inFlightSyncKeys.has(syncKey) : false;
                    const selectedType = syncKey ? getTypeForKey(syncKey) : "general_doc";
                    const typeLocked = syncKey ? isTypeLocked(syncKey) : false;

                    return (
                      <div
                        className="flex w-full items-center justify-between gap-3 rounded-sm p-2 hover:bg-accent"
                        key={item.id}
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
                            </>
                          ) : syncKey ? (
                            <>
                              <Select
                                onValueChange={(value) => {
                                  const v = value as IngestDocumentType;
                                  setTypeForKey(syncKey, v);
                                }}
                                value={selectedType}
                              >
                                <SelectTrigger
                                  className="h-8 w-[190px] text-xs [&>span]:flex-1 [&>span]:text-left"
                                  disabled={!item.driveId || !selectedProjectId || typeLocked}
                                >
                                  <SelectValue placeholder="Doc type" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="general_doc">General doc</SelectItem>
                                  <SelectItem value="bank_statement">
                                    Bank statement
                                  </SelectItem>
                                  <SelectItem value="cc_statement">CC statement</SelectItem>
                                  <SelectItem value="invoice">Invoice</SelectItem>
                                </SelectContent>
                              </Select>
                              <Button
                                disabled={isSyncing || !item.driveId || !selectedProjectId}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!item.driveId) return;
                                  requestImport({
                                    driveId: item.driveId,
                                    items: [{ itemId: item.id, filename: label }],
                                    documentType: syncKey
                                      ? (syncedDocByKey[syncKey]?.documentType ??
                                        selectedType)
                                      : selectedType,
                                  });
                                }}
                                aria-label="Import file"
                                title={isSyncing ? "Processing" : "Import"}
                                size="sm"
                                type="button"
                                variant="outline"
                                className="shrink-0 whitespace-nowrap"
                              >
                                {isSyncing ? (
                                  <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Processing…
                                  </>
                                ) : (
                                  <>
                                    <RefreshCw className="h-4 w-4" />
                                    Import
                                  </>
                                )}
                              </Button>
                            </>
                          ) : (
                            <Button
                              disabled={true}
                              size="sm"
                              type="button"
                              className="shrink-0 whitespace-nowrap"
                            >
                              Import
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
              </div>
            </div>
          )}

          {/* Synced files (table) */}
          {selectedProjectId && (syncedDocsData?.docs ?? []).length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium flex items-center gap-2">
                  <History className="h-4 w-4" />
                  Synced files
                </div>
              </div>

              <div className="rounded-md border overflow-hidden">
                <div className="hidden sm:grid grid-cols-[1fr_120px_100px_150px_100px] gap-3 px-3 py-2 text-xs text-muted-foreground border-b">
                  <div>Name</div>
                  <div>Document type</div>
                  <div>Status</div>
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
                    const status = getDisplayStatus({
                      parseStatus: doc.parseStatus,
                      isSyncing,
                    });
                    return (
                      <div
                        className="flex flex-col gap-2 px-3 py-3 text-xs sm:grid sm:grid-cols-[1fr_120px_100px_150px_100px] sm:items-center sm:gap-3 sm:py-2"
                        key={doc.docId}
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium" title={doc.filename}>
                            {displayName}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:hidden">
                            <span>{formatDocType(selectedType)}</span>
                            <span>·</span>
                            <span className="inline-flex items-center gap-1">
                              {status.isProcessing ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : null}
                              {status.label}
                            </span>
                            {status.detail ? <span>({status.detail})</span> : null}
                          </div>
                        </div>
                        <div className="hidden sm:block min-w-0 truncate text-muted-foreground">
                          {formatDocType(selectedType)}
                        </div>
                        <div className="hidden sm:block min-w-0 truncate text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            {status.isProcessing ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : null}
                            {status.label}
                          </span>
                          {status.detail ? (
                            <span className="ml-1 text-muted-foreground" title={status.detail}>
                              ({status.detail})
                            </span>
                          ) : null}
                        </div>
                        <div className="hidden sm:block truncate text-muted-foreground">
                          {new Date(doc.lastSyncedAt).toLocaleString()}
                        </div>
                        <div className="flex items-center justify-end gap-1 sm:justify-end">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                aria-label="Document type locked"
                                disabled={true}
                                size="icon"
                                title="Document type is locked"
                                type="button"
                                variant="ghost"
                                className="h-8 w-8"
                              >
                                <Info className="h-4 w-4 text-muted-foreground" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              Document type is locked after first sync. To change it (or switch
                              accounts), remove and re-import.
                            </TooltipContent>
                          </Tooltip>
                          <Button
                            disabled={isSyncing || !selectedProjectId}
                            onClick={() => {
                              requestImport({
                                driveId: doc.driveId,
                                items: [{ itemId: doc.itemId, filename: doc.filename }],
                                documentType: doc.documentType ?? selectedType,
                              });
                            }}
                            aria-label="Import file"
                            title={isSyncing ? "Processing" : "Import"}
                            size="icon"
                            type="button"
                            variant="outline"
                            className="h-8 w-8"
                          >
                            {isSyncing ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="h-4 w-4" />
                            )}
                          </Button>
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
                    const selectedType = getTypeForKey(syncKey);
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
                            <>
                              <Select
                                onValueChange={(value) => {
                                  const v = value as IngestDocumentType;
                                  setTypeForKey(syncKey, v);
                                }}
                                value={selectedType}
                              >
                                <SelectTrigger
                                  className="h-8 w-[190px] text-xs [&>span]:flex-1 [&>span]:text-left"
                                  disabled={isSyncing || !selectedProjectId}
                                >
                                  <SelectValue placeholder="Doc type" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="general_doc">General doc</SelectItem>
                                  <SelectItem value="bank_statement">
                                    Bank statement
                                  </SelectItem>
                                  <SelectItem value="cc_statement">CC statement</SelectItem>
                                  <SelectItem value="invoice">Invoice</SelectItem>
                                </SelectContent>
                              </Select>
                              <Button
                                disabled={isSyncing || !selectedProjectId}
                                onClick={() => {
                                  requestImport({
                                    driveId: selectedDriveId,
                                    items: [{ itemId: item.id, filename: label }],
                                    documentType: selectedType,
                                  });
                                }}
                                aria-label="Import file"
                                title="Import file"
                                size="icon"
                                type="button"
                                variant="outline"
                                className="h-8 w-8"
                              >
                                <RefreshCw className="h-4 w-4" />
                              </Button>
                            </>
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

      <Dialog
        onOpenChange={(open) => {
          if (!open) setInvoiceSyncDialog(null);
        }}
        open={invoiceSyncDialog !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import invoice</DialogTitle>
            <DialogDescription>
              Choose whether this is Personal or Business. If Business, select or type a business name. Sender/recipient are optional.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="grid gap-1">
              <label className="text-xs text-muted-foreground" htmlFor="ms-import-entity-kind-invoice">
                Entity type
              </label>
              <Select
                onValueChange={(value) => setImportEntityKind(value as "personal" | "business")}
                value={importEntityKind}
              >
                <SelectTrigger className="h-9" id="ms-import-entity-kind-invoice">
                  <SelectValue placeholder="Select entity type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">Personal</SelectItem>
                  <SelectItem value="business">Business</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {importEntityKind === "business" ? (
              <div className="grid gap-1">
                <label className="text-xs text-muted-foreground" htmlFor="ms-import-business-name-invoice">
                  Business name
                </label>
                <BusinessNameTypeahead
                  inputId="ms-import-business-name-invoice"
                  onChange={setImportBusinessName}
                  options={businessNamesData?.names ?? []}
                  placeholder="Start typing a business name"
                  value={importBusinessName}
                />
              </div>
            ) : null}

            {importEntityKind === "business" ? (
              <div className="text-[11px] text-muted-foreground">
                Start typing to reuse an existing business name, or type a new one.
              </div>
            ) : null}

            <div className="grid gap-1">
              <label
                className="text-xs text-muted-foreground"
                htmlFor="ms-invoice-sender"
              >
                Sender (optional)
              </label>
              <Input
                autoComplete="off"
                id="ms-invoice-sender"
                list="ms-invoice-sender-options"
                onChange={(e) => setInvoiceSender(e.target.value)}
                placeholder="Select or type sender"
                value={invoiceSender}
              />
              <datalist id="ms-invoice-sender-options">
                {(invoiceParties?.senders ?? []).map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            </div>

            <div className="grid gap-1">
              <label
                className="text-xs text-muted-foreground"
                htmlFor="ms-invoice-recipient"
              >
                Recipient (optional)
              </label>
              <Input
                autoComplete="off"
                id="ms-invoice-recipient"
                list="ms-invoice-recipient-options"
                onChange={(e) => setInvoiceRecipient(e.target.value)}
                placeholder="Select or type recipient"
                value={invoiceRecipient}
              />
              <datalist id="ms-invoice-recipient-options">
                {(invoiceParties?.recipients ?? []).map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            </div>
          </div>

          <DialogFooter>
            <Button
              onClick={() => setInvoiceSyncDialog(null)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!invoiceSyncDialog) return;
                const entityName =
                  importEntityKind === "personal"
                    ? "Personal"
                    : importBusinessName.trim();
                if (importEntityKind === "business" && entityName.length === 0) {
                  toast.error("Business name is required");
                  return;
                }
                void importItems({
                  driveId: invoiceSyncDialog.driveId,
                  items: invoiceSyncDialog.items,
                  documentType: "invoice",
                  entityKind: importEntityKind,
                  entityName,
                  invoiceSender,
                  invoiceRecipient,
                });
                setInvoiceSyncDialog(null);
              }}
              type="button"
            >
              Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setImportDialog(null);
        }}
        open={importDialog !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import file</DialogTitle>
            <DialogDescription>
              Choose whether this is Personal or Business. If Business, select or type a business name.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="grid gap-1">
              <label className="text-xs text-muted-foreground" htmlFor="ms-import-entity-kind">
                Entity type
              </label>
              <Select
                onValueChange={(value) => setImportEntityKind(value as "personal" | "business")}
                value={importEntityKind}
              >
                <SelectTrigger className="h-9" id="ms-import-entity-kind">
                  <SelectValue placeholder="Select entity type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">Personal</SelectItem>
                  <SelectItem value="business">Business</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {importEntityKind === "business" ? (
              <div className="grid gap-1">
                <label className="text-xs text-muted-foreground" htmlFor="ms-import-business-name">
                  Business name
                </label>
                <BusinessNameTypeahead
                  inputId="ms-import-business-name"
                  onChange={setImportBusinessName}
                  options={businessNamesData?.names ?? []}
                  placeholder="Start typing a business name"
                  value={importBusinessName}
                />
              </div>
            ) : null}
          </div>
          {importEntityKind === "business" ? (
            <div className="text-[11px] text-muted-foreground">
              Start typing to reuse an existing business name, or type a new one.
            </div>
          ) : null}

          <DialogFooter>
            <Button
              onClick={() => setImportDialog(null)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!importDialog) return;
                const entityName =
                  importEntityKind === "personal"
                    ? "Personal"
                    : importBusinessName.trim();
                if (importEntityKind === "business" && entityName.length === 0) {
                  toast.error("Business name is required");
                  return;
                }
                void importItems({
                  driveId: importDialog.driveId,
                  items: importDialog.items,
                  documentType: importDialog.documentType,
                  entityKind: importEntityKind,
                  entityName,
                });
                setImportDialog(null);
              }}
              type="button"
            >
              Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
