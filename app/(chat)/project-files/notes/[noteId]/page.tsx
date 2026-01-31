import { redirect } from "next/navigation";
import { Suspense } from "react";
import { auth } from "@/app/(auth)/auth";
import { NoteEditor } from "@/components/note-editor";

export default function Page({
  params,
}: {
  params: Promise<{ noteId: string }>;
}) {
  return (
    <Suspense fallback={<div className="flex h-dvh items-center justify-center">Loading...</div>}>
      <NoteEditorPage params={params} />
    </Suspense>
  );
}

async function NoteEditorPage({
  params,
}: {
  params: Promise<{ noteId: string }>;
}) {
  const session = await auth();
  if (!session) {
    const { noteId } = await params;
    redirect(`/api/auth/guest?redirectUrl=/project-files/notes/${noteId}`);
  }

  const { noteId } = await params;

  return <NoteEditor noteId={noteId} />;
}
