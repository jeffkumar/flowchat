import type { UseChatHelpers } from "@ai-sdk/react";
import equal from "fast-deep-equal";
import { ArrowDownIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { useMessages } from "@/hooks/use-messages";
import type { Vote } from "@/lib/db/schema";
import type { ChatMessage } from "@/lib/types";
import { useDataStream } from "./data-stream-provider";
import { Greeting } from "./greeting";
import { PreviewMessage, ThinkingMessage } from "./message";

type MessagesProps = {
  chatId: string;
  status: UseChatHelpers<ChatMessage>["status"];
  votes: Vote[] | undefined;
  messages: ChatMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  isArtifactVisible: boolean;
  selectedModelId: string;
  showCitations: boolean;
};

function PureMessages({
  chatId,
  status,
  votes,
  messages,
  setMessages,
  regenerate,
  isReadonly,
  selectedModelId: _selectedModelId,
  showCitations,
}: MessagesProps) {
  const {
    containerRef: messagesContainerRef,
    endRef: messagesEndRef,
    isAtBottom,
    scrollToBottom,
    hasSentMessage,
  } = useMessages({
    status,
  });

  const { dataStream } = useDataStream();
  const [agentStatus, setAgentStatus] = useState<
    { agent: string; message: string } | undefined
  >();

  useEffect(() => {
    if (!dataStream?.length) return;

    for (let i = dataStream.length - 1; i >= 0; i -= 1) {
      const part = dataStream[i];
      if (part.type === "data-agentStatus") {
        setAgentStatus(part.data);
        return;
      }
    }
  }, [dataStream]);

  const lastMessage = messages.at(-1);
  const lastAssistantHasVisibleContent = (() => {
    if (lastMessage?.role !== "assistant") return false;
    const parts = Array.isArray(lastMessage.parts) ? lastMessage.parts : [];
    for (const part of parts) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
        return true;
      }
      if (part.type === "file") {
        return true;
      }
      if (
        part.type === "reasoning" &&
        typeof part.text === "string" &&
        part.text.trim().length > 0
      ) {
        return true;
      }
      if (typeof part.type === "string" && part.type.startsWith("tool-")) {
        return true;
      }
    }
    return false;
  })();

  const shouldShowThinkingMessage =
    status === "submitted" ||
    (status === "streaming" &&
      (lastMessage?.role !== "assistant" || !lastAssistantHasVisibleContent));
  const thinkingShowIcon = status === "submitted" || lastMessage?.role !== "assistant";

  return (
    <div className="relative flex-1">
      <div
        className="absolute inset-0 touch-pan-y overflow-y-auto"
        ref={messagesContainerRef}
      >
        <div className="mx-auto flex min-w-0 max-w-4xl flex-col gap-4 px-2 py-4 md:gap-6 md:px-4">
          {messages.length === 0 && <Greeting />}

          {messages.map((message, index) => (
            <PreviewMessage
              chatId={chatId}
              isLoading={
                status === "streaming" && messages.length - 1 === index
              }
              isReadonly={isReadonly}
              key={message.id}
              message={message}
              regenerate={regenerate}
              requiresScrollPadding={
                hasSentMessage && index === messages.length - 1
              }
              setMessages={setMessages}
              vote={
                votes
                  ? votes.find((vote) => vote.messageId === message.id)
                  : undefined
              }
              showCitations={showCitations}
            />
          ))}

          {shouldShowThinkingMessage && (
            <ThinkingMessage agentStatus={agentStatus} showIcon={thinkingShowIcon} />
          )}

          <div
            className="min-h-[24px] min-w-[24px] shrink-0"
            ref={messagesEndRef}
          />
        </div>
      </div>

      <button
        aria-label="Scroll to bottom"
        className={`-translate-x-1/2 absolute bottom-4 left-1/2 z-10 rounded-full border bg-background p-2 shadow-lg transition-all hover:bg-muted ${
          isAtBottom
            ? "pointer-events-none scale-0 opacity-0"
            : "pointer-events-auto scale-100 opacity-100"
        }`}
        onClick={() => scrollToBottom("smooth")}
        type="button"
      >
        <ArrowDownIcon className="size-4" />
      </button>
    </div>
  );
}

export const Messages = memo(PureMessages, (prevProps, nextProps) => {
  if (prevProps.isArtifactVisible && nextProps.isArtifactVisible) {
    return true;
  }

  if (prevProps.status !== nextProps.status) {
    return false;
  }
  if (prevProps.selectedModelId !== nextProps.selectedModelId) {
    return false;
  }
  if (prevProps.messages.length !== nextProps.messages.length) {
    return false;
  }
  if (!equal(prevProps.messages, nextProps.messages)) {
    return false;
  }
  if (!equal(prevProps.votes, nextProps.votes)) {
    return false;
  }
  if (prevProps.showCitations !== nextProps.showCitations) {
    return false;
  }

  return false;
});
