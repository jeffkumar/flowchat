"use client";

import Link from "next/link";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import type { User } from "next-auth";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { unstable_serialize } from "swr/infinite";
import { TrashIcon } from "@/components/icons";
import {
  getChatHistoryPaginationKey,
  SidebarHistory,
} from "@/components/sidebar-history";
import { SidebarUserNav } from "@/components/sidebar-user-nav";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useProjectSelector } from "@/hooks/use-project-selector";
import { cn } from "@/lib/utils";
import { Bot, FileText, MessageSquarePlus, Notebook, Plug2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function AppSidebar({ user }: { user: User | undefined }) {
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  const { mutate } = useSWRConfig();
  const [showDeleteAllDialog, setShowDeleteAllDialog] = useState(false);
  const { selectedProjectId, selectedProject } = useProjectSelector();
  const { resolvedTheme } = useTheme();
  const [hasMounted, setHasMounted] = useState(false);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  const shouldInvertSidebar = hasMounted && resolvedTheme === "light";

  const handleDeleteAll = () => {
    if (!selectedProjectId) {
      toast.error("No project selected");
      return;
    }

    const deletePromise = fetch(`/api/history?projectId=${selectedProjectId}`, {
      method: "DELETE",
    });

    toast.promise(deletePromise, {
      loading: "Deleting project chats...",
      success: () => {
        mutate(
          unstable_serialize((index, previousPageData) =>
            getChatHistoryPaginationKey(
              index,
              previousPageData,
              selectedProjectId
            )
          )
        );
        router.push("/");
        setShowDeleteAllDialog(false);
        return "Project chats deleted successfully";
      },
      error: "Failed to delete project chats",
    });
  };

  return (
    <>
      <Sidebar
        className={cn(
          "group-data-[side=left]:border-r-0",
          shouldInvertSidebar && "sidebar-inverted"
        )}
      >
        <SidebarHeader>
          <SidebarMenu>
            <div className="flex flex-row items-center justify-between">
              <Link
                className="flex flex-row items-center gap-3"
                href="/"
                onClick={() => {
                  setOpenMobile(false);
                }}
              >
                <span className="cursor-pointer rounded-md px-2 font-semibold text-lg hover:bg-muted">
                  Flowchat
                </span>
              </Link>
              <div className="flex flex-row gap-1">
                {user && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        className="h-8 p-1 md:h-fit md:p-2"
                        onClick={() => setShowDeleteAllDialog(true)}
                        type="button"
                        variant="ghost"
                      >
                        <TrashIcon />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent align="end" className="hidden md:block">
                      Delete Project Chats
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <div className="px-2 pt-2 pb-1">
            <Button
              className="w-full justify-start gap-2"
              variant="outline"
              onClick={() => {
                router.push("/");
                setOpenMobile(false);
              }}
            >
              <MessageSquarePlus className="h-4 w-4" />
              New Chat
            </Button>
          </div>
          <div className="px-2 py-2">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link
                    href="/integrations"
                    onClick={() => setOpenMobile(false)}
                  >
                    <Plug2 className="h-4 w-4" />
                    <span>Integrations</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link
                    href="/project-files"
                    onClick={() => setOpenMobile(false)}
                  >
                    <FileText className="h-4 w-4" />
                    <span>Project Files</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link
                    href="/project-files/notes"
                    onClick={() => setOpenMobile(false)}
                  >
                    <Notebook className="h-4 w-4" />
                    <span>Notes</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link
                    href="/agents"
                    onClick={() => setOpenMobile(false)}
                  >
                    <Bot className="h-4 w-4" />
                    <span>Agents</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </div>
          <SidebarHistory user={user} />
        </SidebarContent>
        <SidebarFooter>{user && <SidebarUserNav user={user} />}</SidebarFooter>
      </Sidebar>

      <AlertDialog
        onOpenChange={setShowDeleteAllDialog}
        open={showDeleteAllDialog}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete all chats for {selectedProject?.name ?? "this project"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete all
              chats in this project and remove them from our servers.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteAll}>
              Delete All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
