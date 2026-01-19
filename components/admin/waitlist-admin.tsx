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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fetcher } from "@/lib/utils";

type WaitlistRequest = {
  id: string;
  email: string;
  businessName: string;
  phoneNumber: string;
  address: string;
  country: string;
  state: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
};

type WaitlistResponse = { requests: WaitlistRequest[] };

export function WaitlistAdmin() {
  const { data, error, isLoading, mutate } = useSWR<WaitlistResponse>(
    "/api/admin/waitlist",
    fetcher,
    { shouldRetryOnError: false, refreshInterval: 5000 }
  );

  const [query, setQuery] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<WaitlistRequest | null>(null);
  const [actionType, setActionType] = useState<"approve" | "reject" | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const requests = data?.requests ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return requests;
    return requests.filter(
      (r) =>
        r.email.toLowerCase().includes(q) ||
        r.businessName.toLowerCase().includes(q) ||
        r.country.toLowerCase().includes(q)
    );
  }, [requests, query]);

  const pendingRequests = filtered.filter((r) => r.status === "pending");
  const approvedRequests = filtered.filter((r) => r.status === "approved");
  const rejectedRequests = filtered.filter((r) => r.status === "rejected");

  const openConfirm = (request: WaitlistRequest, type: "approve" | "reject") => {
    setSelectedRequest(request);
    setActionType(type);
    setConfirmOpen(true);
  };

  const doAction = async () => {
    if (!selectedRequest || !actionType) return;

    setIsProcessing(true);
    try {
      const response = await fetch("/api/admin/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: selectedRequest.id,
          action: actionType,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to process request");
      }

      toast.success(
        `Request ${actionType === "approve" ? "approved" : "rejected"} successfully`
      );

      setConfirmOpen(false);
      setSelectedRequest(null);
      setActionType(null);
      await mutate();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to process request"
      );
    } finally {
      setIsProcessing(false);
    }
  };

  if (error) {
    return (
      <div className="text-center text-muted-foreground">
        Failed to load waitlist requests. Please try again.
      </div>
    );
  }

  if (isLoading) {
    return <div className="text-center text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Input
          className="max-w-sm"
          placeholder="Search by email, business name, or country..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Pending</CardTitle>
            <CardDescription>{pendingRequests.length} requests</CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Approved</CardTitle>
            <CardDescription>{approvedRequests.length} requests</CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Rejected</CardTitle>
            <CardDescription>{rejectedRequests.length} requests</CardDescription>
          </CardHeader>
        </Card>
      </div>

      <ScrollArea className="h-[600px]">
        <div className="space-y-4">
          {filtered.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              No waitlist requests found.
            </div>
          ) : (
            filtered.map((request) => (
              <Card key={request.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <CardTitle className="text-base">{request.businessName}</CardTitle>
                      <CardDescription>{request.email}</CardDescription>
                    </div>
                    <Badge
                      variant={
                        request.status === "approved"
                          ? "default"
                          : request.status === "rejected"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {request.status}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid gap-2 text-sm md:grid-cols-2">
                    <div>
                      <span className="font-medium">Phone:</span> {request.phoneNumber}
                    </div>
                    <div>
                      <span className="font-medium">Country:</span> {request.country}
                      {request.state && `, ${request.state}`}
                    </div>
                    <div className="md:col-span-2">
                      <span className="font-medium">Address:</span> {request.address}
                    </div>
                    <div className="md:col-span-2">
                      <span className="font-medium">Requested:</span>{" "}
                      {new Date(request.createdAt).toLocaleString()}
                    </div>
                    {request.approvedAt && (
                      <div className="md:col-span-2">
                        <span className="font-medium">
                          {request.status === "approved" ? "Approved" : "Rejected"}:
                        </span>{" "}
                        {new Date(request.approvedAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                  {request.status === "pending" && (
                    <div className="flex gap-2 pt-2">
                      <Button
                        size="sm"
                        onClick={() => openConfirm(request, "approve")}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => openConfirm(request, "reject")}
                      >
                        Reject
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </ScrollArea>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {actionType === "approve" ? "Approve" : "Reject"} Waitlist Request?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {actionType === "approve" ? (
                <>
                  Are you sure you want to approve the request from{" "}
                  <strong>{selectedRequest?.businessName}</strong> ({selectedRequest?.email})?
                  They will be able to create an account after approval.
                </>
              ) : (
                <>
                  Are you sure you want to reject the request from{" "}
                  <strong>{selectedRequest?.businessName}</strong> ({selectedRequest?.email})?
                  This action cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isProcessing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={doAction}
              disabled={isProcessing}
              className={actionType === "reject" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
            >
              {isProcessing ? "Processing..." : actionType === "approve" ? "Approve" : "Reject"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
