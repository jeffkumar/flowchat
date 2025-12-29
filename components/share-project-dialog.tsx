"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { CheckCircle2, Clock, Trash2 } from "lucide-react";
import { fetcher } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ProjectMemberRow =
  | {
      kind: "user";
      userId: string;
      email: string;
      role: "owner" | "admin" | "member";
      status: "active";
    }
  | {
      kind: "invite";
      email: string;
      role: "admin" | "member";
      status: "pending";
    };

export function ShareProjectDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, mutate, isLoading } = useSWR<{ members: ProjectMemberRow[] }>(
    open ? `/api/projects/${projectId}/members` : null,
    fetcher
  );

  const members = useMemo(() => data?.members ?? [], [data?.members]);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const invite = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;

    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmed, role }),
      });

      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error || "Failed to invite");
      }

      toast.success("Invite sent");
      setEmail("");
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to invite");
    } finally {
      setIsSubmitting(false);
    }
  };

  const updateRole = async (member: ProjectMemberRow, nextRole: "admin" | "member") => {
    if (member.kind === "user" && member.role === "owner") return;

    const memberId = member.kind === "user" ? member.userId : member.email;
    try {
      const res = await fetch(
        `/api/projects/${projectId}/members/${encodeURIComponent(memberId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: nextRole }),
        }
      );

      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error || "Failed to update role");
      }

      toast.success("Role updated");
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update role");
    }
  };

  const remove = async (member: ProjectMemberRow) => {
    if (member.kind === "user" && member.role === "owner") return;

    const memberId = member.kind === "user" ? member.userId : member.email;
    try {
      const res = await fetch(
        `/api/projects/${projectId}/members/${encodeURIComponent(memberId)}`,
        { method: "DELETE" }
      );

      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error || "Failed to remove");
      }

      toast.success(member.kind === "invite" ? "Invite removed" : "Member removed");
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Share project</DialogTitle>
          <DialogDescription>
            Invite members by email. Admins can manage integrations and files; members are
            read-only.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email@example.com"
            autoComplete="email"
          />
          <Select value={role} onValueChange={(v) => setRole(v as "admin" | "member")}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">Member</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
            </SelectContent>
          </Select>
          <Button type="button" onClick={invite} disabled={isSubmitting || !email.trim()}>
            Invite
          </Button>
        </div>

        <div className="mt-4 space-y-2">
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading members…</div>
          ) : members.length === 0 ? (
            <div className="text-sm text-muted-foreground">No members yet.</div>
          ) : (
            members.map((m) => {
              const key = m.kind === "user" ? m.userId : `invite:${m.email}`;
              const roleValue = m.kind === "user" ? m.role : m.role;
              const statusLabel = m.status === "active" ? "Active" : "Pending";
              const StatusIcon = m.status === "active" ? CheckCircle2 : Clock;

              return (
                <div key={key} className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="truncate">{m.email}</div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <StatusIcon
                        className={m.status === "active" ? "h-4 w-4 text-brand" : "h-4 w-4"}
                      />
                      <span>{statusLabel}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Select
                      value={roleValue}
                      onValueChange={(v) => updateRole(m, v as "admin" | "member")}
                      disabled={m.kind === "user" && m.role === "owner"}
                    >
                      <SelectTrigger className="w-[140px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {m.kind === "user" && m.role === "owner" && (
                          <SelectItem value="owner">Owner</SelectItem>
                        )}
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>

                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => remove(m)}
                      disabled={m.kind === "user" && m.role === "owner"}
                      title={m.kind === "invite" ? "Remove invite" : "Remove member"}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <DialogFooter />
      </DialogContent>
    </Dialog>
  );
}


