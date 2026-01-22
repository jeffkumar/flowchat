import { redirect } from "next/navigation";
import { Suspense } from "react";
import { auth } from "@/app/(auth)/auth";
import { ProjectFilesHeader } from "@/components/project-files-header";
import { ProjectFilesViewer } from "@/components/project-files-viewer";

export default function Page() {
  return (
    <Suspense fallback={<div className="flex h-dvh" />}>
      <ProjectFilesPage />
    </Suspense>
  );
}

async function ProjectFilesPage() {
  const session = await auth();
  if (!session) {
    redirect("/api/auth/guest?redirectUrl=/project-files");
  }

  return (
    <>
      <ProjectFilesHeader />
      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Project Files</h1>
          <p className="text-sm text-muted-foreground">
            Browse project documents and manage context visibility.
          </p>
        </div>

        <div className="mt-6">
          <ProjectFilesViewer />
        </div>
      </div>
    </>
  );
}

