import { redirect } from "next/navigation";
import { Suspense } from "react";
import { auth } from "@/app/(auth)/auth";
import { ProjectFilesHeader } from "@/components/project-files-header";
import { AgentsViewer } from "@/components/agents-viewer";
import { WorkflowAgentsViewer } from "@/components/workflow-agents-viewer";

export default function Page() {
  return (
    <Suspense fallback={<div className="flex h-dvh" />}>
      <AgentsPage />
    </Suspense>
  );
}

async function AgentsPage() {
  const session = await auth();
  if (!session) {
    redirect("/api/auth/guest?redirectUrl=/agents");
  }

  return (
    <>
      <ProjectFilesHeader />
      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Agents</h1>
          <p className="text-sm text-muted-foreground">
            Manage built-in and custom agents for your project.
          </p>
        </div>

        {/* Chat Agents Section */}
        <div className="mt-8">
          <h2 className="mb-4 text-lg font-medium">Chat Agents</h2>
          <AgentsViewer />
        </div>

        {/* Workflow Agents Section */}
        <div className="mt-10">
          <div className="mb-4 space-y-1">
            <h2 className="text-lg font-medium">Workflow Agents</h2>
            <p className="text-sm text-muted-foreground">
              Configure how documents are parsed and extracted. Override defaults for specific document types.
            </p>
          </div>
          <WorkflowAgentsViewer />
        </div>
      </div>
    </>
  );
}
