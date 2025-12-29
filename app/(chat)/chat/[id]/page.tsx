import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { auth } from "@/app/(auth)/auth";
import { Chat } from "@/components/chat";
import { DataStreamHandler } from "@/components/data-stream-handler";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { getChatById, getMessagesByChatId } from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";
import { convertToUIMessages } from "@/lib/utils";

export default function Page(props: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<div className="flex h-dvh" />}>
      <ChatPage params={props.params} />
    </Suspense>
  );
}

async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let chat: Awaited<ReturnType<typeof getChatById>>;
  try {
    chat = await getChatById({ id });
  } catch (error) {
    if (error instanceof ChatSDKError && error.type === "offline") {
      return (
        <div className="flex h-dvh items-center justify-center">
          <div className="text-sm text-muted-foreground">
            Database is temporarily unavailable. Please retry in a moment.
          </div>
        </div>
      );
    }
    throw error;
  }

  if (!chat) {
    notFound();
  }

  const session = await auth();

  if (!session) {
    redirect("/api/auth/guest");
  }

  if (chat.visibility === "private") {
    if (!session.user) {
      return notFound();
    }

    if (session.user.id !== chat.userId) {
      return notFound();
    }
  }

  let messagesFromDb: Awaited<ReturnType<typeof getMessagesByChatId>>;
  try {
    messagesFromDb = await getMessagesByChatId({ id });
  } catch (error) {
    if (error instanceof ChatSDKError && error.type === "offline") {
      return (
        <>
          <Chat
            autoResume={true}
            id={chat.id}
            initialChatModel={DEFAULT_CHAT_MODEL}
            initialLastContext={chat.lastContext ?? undefined}
            initialMessages={[]}
            initialVisibilityType={chat.visibility}
            isReadonly={session?.user?.id !== chat.userId}
          />
          <DataStreamHandler />
          <div className="mx-auto max-w-2xl px-4 py-6 text-sm text-muted-foreground">
            Database is temporarily unavailable; showing the chat shell without message history.
          </div>
        </>
      );
    }
    throw error;
  }

  const uiMessages = convertToUIMessages(messagesFromDb);

  const cookieStore = await cookies();
  const chatModelFromCookie = cookieStore.get("chat-model");

  if (!chatModelFromCookie) {
    return (
      <>
        <Chat
          autoResume={true}
          id={chat.id}
          initialChatModel={DEFAULT_CHAT_MODEL}
          initialLastContext={chat.lastContext ?? undefined}
          initialMessages={uiMessages}
          initialVisibilityType={chat.visibility}
          isReadonly={session?.user?.id !== chat.userId}
        />
        <DataStreamHandler />
      </>
    );
  }

  return (
    <>
      <Chat
        autoResume={true}
        id={chat.id}
        initialChatModel={chatModelFromCookie.value}
        initialLastContext={chat.lastContext ?? undefined}
        initialMessages={uiMessages}
        initialVisibilityType={chat.visibility}
        isReadonly={session?.user?.id !== chat.userId}
      />
      <DataStreamHandler />
    </>
  );
}
