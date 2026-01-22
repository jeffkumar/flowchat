import type { UseChatHelpers } from "@ai-sdk/react";
import equal from "fast-deep-equal";
import { AnimatePresence, motion } from "framer-motion";
import { memo, useEffect, useState } from "react";
import { useMessages } from "@/hooks/use-messages";
import type { Vote } from "@/lib/db/schema";
import type { ChatMessage, EntityOption } from "@/lib/types";
import type { UIArtifact } from "./artifact";
import { useDataStream } from "./data-stream-provider";
import { PreviewMessage, ThinkingMessage } from "./message";

type ArtifactMessagesProps = {
  chatId: string;
  status: UseChatHelpers<ChatMessage>["status"];
  votes: Vote[] | undefined;
  messages: ChatMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  artifactStatus: UIArtifact["status"];
  selectedEntities?: EntityOption[];
  onEntitySelection?: (args: { entities: EntityOption[]; questionId: string }) => void;
};

function PureArtifactMessages({
  chatId,
  status,
  votes,
  messages,
  setMessages,
  regenerate,
  isReadonly,
  selectedEntities,
  onEntitySelection,
}: ArtifactMessagesProps) {
  const {
    containerRef: messagesContainerRef,
    endRef: messagesEndRef,
    onViewportEnter,
    onViewportLeave,
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
  const shouldShowThinkingMessage = status === "submitted" || status === "streaming";
  const thinkingShowIcon = status === "submitted" || lastMessage?.role !== "assistant";

  return (
    <div
      className="flex h-full flex-col items-center gap-4 overflow-y-scroll px-4 pt-20"
      ref={messagesContainerRef}
    >
      {messages.map((message, index) => (
        <PreviewMessage
          chatId={chatId}
          isLoading={status === "streaming" && index === messages.length - 1}
          isReadonly={isReadonly}
          key={message.id}
          message={message}
          onEntitySelection={onEntitySelection}
          showCitations={true}
          regenerate={regenerate}
          requiresScrollPadding={
            hasSentMessage && index === messages.length - 1
          }
          setMessages={setMessages}
          selectedEntities={selectedEntities}
          vote={
            votes
              ? votes.find((vote) => vote.messageId === message.id)
              : undefined
          }
        />
      ))}

      <AnimatePresence mode="wait">
        {shouldShowThinkingMessage && (
          <div className="z-10 w-full self-stretch" key="thinking">
            <div className="bg-background/80 backdrop-blur-sm">
              <ThinkingMessage agentStatus={agentStatus} showIcon={thinkingShowIcon} />
            </div>
          </div>
        )}
      </AnimatePresence>

      <motion.div
        className="min-h-[24px] min-w-[24px] shrink-0"
        onViewportEnter={onViewportEnter}
        onViewportLeave={onViewportLeave}
        ref={messagesEndRef}
      />
    </div>
  );
}

function areEqual(
  prevProps: ArtifactMessagesProps,
  nextProps: ArtifactMessagesProps
) {
  if (
    prevProps.artifactStatus === "streaming" &&
    nextProps.artifactStatus === "streaming"
  ) {
    return true;
  }

  if (prevProps.status !== nextProps.status) {
    return false;
  }
  if (prevProps.status && nextProps.status) {
    return false;
  }
  if (prevProps.messages.length !== nextProps.messages.length) {
    return false;
  }
  if (!equal(prevProps.votes, nextProps.votes)) {
    return false;
  }

  return true;
}

export const ArtifactMessages = memo(PureArtifactMessages, areEqual);
