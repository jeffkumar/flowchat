import { redirect } from "next/navigation";
import { Suspense } from "react";
import { auth } from "@/app/(auth)/auth";
import { ProjectFilesHeader } from "@/components/project-files-header";
import { NotesViewer } from "@/components/notes-viewer";

export default function Page() {
  return (
    <Suspense fallback={<div className="flex h-dvh" />}>
      <NotesPage />
    </Suspense>
  );
}

async function NotesPage() {
  const session = await auth();
  if (!session) {
    redirect("/api/auth/guest?redirectUrl=/project-files/notes");
  }

  return (
    <>
      <ProjectFilesHeader />
      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Notes</h1>
          <p className="text-sm text-muted-foreground">
            Create and manage markdown notes for your project.
          </p>
        </div>

        <div className="mt-6">
          <NotesViewer />
        </div>
      </div>
    </>
  );
}
