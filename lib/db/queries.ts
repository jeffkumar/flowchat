import "server-only";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  type SQL,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { ArtifactKind } from "@/components/artifact";
import type { VisibilityType } from "@/components/visibility-selector";
import { ChatSDKError } from "../errors";
import type { AppUsage } from "../usage";
import { generateUUID } from "../utils";
import {
  type Chat,
  chat,
  type DBMessage,
  document,
  message,
  type Project,
  project,
  type ProjectDoc,
  projectDoc,
  type Suggestion,
  stream,
  suggestion,
  type User,
  user,
  vote,
} from "./schema";
import { generateHashedPassword } from "./utils";

// Optionally, if not using email/pass login, you can
// use the Drizzle adapter for Auth.js / NextAuth
// https://authjs.dev/reference/adapter/drizzle

type PostgresClient = ReturnType<typeof postgres>;
type DbClient = ReturnType<typeof drizzle>;

type GlobalDbCache = {
  __flowchat_postgres_client__?: PostgresClient;
  __flowchat_db__?: DbClient;
};

const globalCache = globalThis as unknown as GlobalDbCache;

const postgresUrl = process.env.POSTGRES_URL;
// biome-ignore lint: Forbidden non-null assertion.
const safePostgresUrl = postgresUrl!;

// Neon/Supabase poolers often run in transaction pooling mode, which is incompatible
// with prepared statements. Disable prepares when we detect a pooler URL.
const isPoolerUrl = safePostgresUrl.includes("-pooler");

const maxConnectionsRaw = process.env.POSTGRES_MAX_CONNECTIONS;
const parsedMax =
  typeof maxConnectionsRaw === "string" && maxConnectionsRaw.length > 0
    ? Number(maxConnectionsRaw)
    : undefined;
const defaultMaxConnections = process.env.NODE_ENV === "production" ? 2 : 5;
const maxConnections =
  typeof parsedMax === "number" && Number.isFinite(parsedMax) && parsedMax > 0
    ? parsedMax
    : defaultMaxConnections;

// In dev (Turbopack/HMR), this module can be re-evaluated often. If we create a new
// postgres-js client each time, we can exhaust DB connections and cause stalls/timeouts.
// Cache the client on globalThis to keep a single pool.
const client =
  globalCache.__flowchat_postgres_client__ ??
  postgres(safePostgresUrl, {
    max: maxConnections,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: !isPoolerUrl,
  });

const db = globalCache.__flowchat_db__ ?? drizzle(client);

if (process.env.NODE_ENV !== "production") {
  globalCache.__flowchat_postgres_client__ = client;
  globalCache.__flowchat_db__ = db;
}

export async function getUser(email: string): Promise<User[]> {
  try {
    return await db.select().from(user).where(eq(user.email, email));
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to get user by email"
    );
  }
}

export async function createUser(email: string, password: string) {
  const hashedPassword = generateHashedPassword(password);

  try {
    return await db.insert(user).values({ email, password: hashedPassword });
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to create user");
  }
}

export async function createGuestUser() {
  const email = `guest-${Date.now()}`;
  const password = generateHashedPassword(generateUUID());

  try {
    return await db.insert(user).values({ email, password }).returning({
      id: user.id,
      email: user.email,
    });
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to create guest user"
    );
  }
}

export async function getProjectsByUserId(userId: string): Promise<Project[]> {
  try {
    return await db
      .select()
      .from(project)
      .where(eq(project.createdBy, userId))
      .orderBy(desc(project.createdAt));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get projects by user id"
    );
  }
}

export async function getProjectByIdForUser({
  projectId,
  userId,
}: {
  projectId: string;
  userId: string;
}): Promise<Project | null> {
  try {
    const [found] = await db
      .select()
      .from(project)
      .where(and(eq(project.id, projectId), eq(project.createdBy, userId)))
      .limit(1);
    return found ?? null;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get project by id"
    );
  }
}

export async function createProject({
  name,
  createdBy,
  organizationId,
}: {
  name: string;
  createdBy: string;
  organizationId?: string | null;
}): Promise<Project> {
  try {
    const [created] = await db
      .insert(project)
      .values({
        name,
        createdBy,
        organizationId: organizationId ?? null,
        isDefault: false,
        createdAt: new Date(),
      })
      .returning();

    if (!created) {
      throw new Error("Project insert returned no row");
    }

    return created;
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to create project");
  }
}

export async function getOrCreateDefaultProjectForUser({
  userId,
  organizationId,
}: {
  userId: string;
  organizationId?: string | null;
}): Promise<Project> {
  try {
    const [existing] = await db
      .select()
      .from(project)
      .where(and(eq(project.createdBy, userId), eq(project.isDefault, true)))
      .limit(1);

    if (existing) {
      return existing;
    }

    try {
      const [created] = await db
        .insert(project)
        .values({
          name: "Default",
          createdBy: userId,
          organizationId: organizationId ?? null,
          isDefault: true,
          createdAt: new Date(),
        })
        .returning();

      if (created) {
        return created;
      }
    } catch (_error) {
      // If there's a race (two requests create default at once), fall through to re-select.
    }

    const [afterRace] = await db
      .select()
      .from(project)
      .where(and(eq(project.createdBy, userId), eq(project.isDefault, true)))
      .limit(1);

    if (!afterRace) {
      throw new Error("Default project not found after create attempt");
    }

    return afterRace;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get or create default project"
    );
  }
}

export async function createProjectDoc({
  projectId,
  createdBy,
  organizationId,
  blobUrl,
  filename,
  mimeType,
  sizeBytes,
  turbopufferNamespace,
}: {
  projectId: string;
  createdBy: string;
  organizationId?: string | null;
  blobUrl: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  turbopufferNamespace?: string | null;
}): Promise<ProjectDoc> {
  try {
    const [created] = await db
      .insert(projectDoc)
      .values({
        projectId,
        createdBy,
        organizationId: organizationId ?? null,
        blobUrl,
        filename,
        mimeType,
        sizeBytes,
        turbopufferNamespace: turbopufferNamespace ?? null,
        createdAt: new Date(),
      })
      .returning();

    if (!created) {
      throw new Error("ProjectDoc insert returned no row");
    }

    return created;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to create project doc"
    );
  }
}

export async function getProjectDocsByProjectId({
  projectId,
}: {
  projectId: string;
}): Promise<ProjectDoc[]> {
  try {
    return await db
      .select()
      .from(projectDoc)
      .where(eq(projectDoc.projectId, projectId))
      .orderBy(desc(projectDoc.createdAt));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get project docs by project id"
    );
  }
}

export async function getProjectDocsByUserId({
  userId,
}: {
  userId: string;
}): Promise<ProjectDoc[]> {
  try {
    return await db
      .select()
      .from(projectDoc)
      .where(eq(projectDoc.createdBy, userId))
      .orderBy(desc(projectDoc.createdAt));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get project docs by user id"
    );
  }
}

export async function markProjectDocIndexed({
  docId,
  indexedAt,
  turbopufferNamespace,
}: {
  docId: string;
  indexedAt: Date;
  turbopufferNamespace?: string | null;
}) {
  try {
    return await db
      .update(projectDoc)
      .set({
        indexedAt,
        turbopufferNamespace: turbopufferNamespace ?? null,
        indexingError: null,
      })
      .where(eq(projectDoc.id, docId));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to mark project doc indexed"
    );
  }
}

export async function markProjectDocIndexError({
  docId,
  error,
}: {
  docId: string;
  error: string;
}) {
  try {
    return await db
      .update(projectDoc)
      .set({
        indexingError: error,
      })
      .where(eq(projectDoc.id, docId));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to mark project doc indexing error"
    );
  }
}

export async function saveChat({
  id,
  userId,
  title,
  visibility,
}: {
  id: string;
  userId: string;
  title: string;
  visibility: VisibilityType;
}) {
  try {
    return await db.insert(chat).values({
      id,
      createdAt: new Date(),
      userId,
      title,
      visibility,
    });
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to save chat");
  }
}

export async function deleteChatById({ id }: { id: string }) {
  try {
    await db.delete(vote).where(eq(vote.chatId, id));
    await db.delete(message).where(eq(message.chatId, id));
    await db.delete(stream).where(eq(stream.chatId, id));

    const [chatsDeleted] = await db
      .delete(chat)
      .where(eq(chat.id, id))
      .returning();
    return chatsDeleted;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete chat by id"
    );
  }
}

export async function deleteAllChatsByUserId({ userId }: { userId: string }) {
  try {
    const userChats = await db
      .select({ id: chat.id })
      .from(chat)
      .where(eq(chat.userId, userId));

    if (userChats.length === 0) {
      return { deletedCount: 0 };
    }

    const chatIds = userChats.map((c) => c.id);

    await db.delete(vote).where(inArray(vote.chatId, chatIds));
    await db.delete(message).where(inArray(message.chatId, chatIds));
    await db.delete(stream).where(inArray(stream.chatId, chatIds));

    const deletedChats = await db
      .delete(chat)
      .where(eq(chat.userId, userId))
      .returning();

    return { deletedCount: deletedChats.length };
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete all chats by user id"
    );
  }
}

export async function getChatsByUserId({
  id,
  limit,
  startingAfter,
  endingBefore,
}: {
  id: string;
  limit: number;
  startingAfter: string | null;
  endingBefore: string | null;
}) {
  try {
    const extendedLimit = limit + 1;

    const query = (whereCondition?: SQL<any>) =>
      db
        .select()
        .from(chat)
        .where(
          whereCondition
            ? and(whereCondition, eq(chat.userId, id))
            : eq(chat.userId, id)
        )
        .orderBy(desc(chat.createdAt))
        .limit(extendedLimit);

    let filteredChats: Chat[] = [];

    if (startingAfter) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, startingAfter))
        .limit(1);

      if (!selectedChat) {
        throw new ChatSDKError(
          "not_found:database",
          `Chat with id ${startingAfter} not found`
        );
      }

      filteredChats = await query(gt(chat.createdAt, selectedChat.createdAt));
    } else if (endingBefore) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, endingBefore))
        .limit(1);

      if (!selectedChat) {
        throw new ChatSDKError(
          "not_found:database",
          `Chat with id ${endingBefore} not found`
        );
      }

      filteredChats = await query(lt(chat.createdAt, selectedChat.createdAt));
    } else {
      filteredChats = await query();
    }

    const hasMore = filteredChats.length > limit;

    return {
      chats: hasMore ? filteredChats.slice(0, limit) : filteredChats,
      hasMore,
    };
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to get chats by user id"
    );
  }
}

export async function getChatById({ id }: { id: string }) {
  try {
    const [selectedChat] = await db.select().from(chat).where(eq(chat.id, id));
    if (!selectedChat) {
      return null;
    }

    return selectedChat;
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to get chat by id");
  }
}

export async function saveMessages({ messages }: { messages: DBMessage[] }) {
  try {
    return await db.insert(message).values(messages);
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to save messages");
  }
}

export async function getMessagesByChatId({ id }: { id: string }) {
  try {
    return await db
      .select()
      .from(message)
      .where(eq(message.chatId, id))
      .orderBy(asc(message.createdAt));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get messages by chat id"
    );
  }
}

export async function voteMessage({
  chatId,
  messageId,
  type,
}: {
  chatId: string;
  messageId: string;
  type: "up" | "down";
}) {
  try {
    const [existingVote] = await db
      .select()
      .from(vote)
      .where(and(eq(vote.messageId, messageId)));

    if (existingVote) {
      return await db
        .update(vote)
        .set({ isUpvoted: type === "up" })
        .where(and(eq(vote.messageId, messageId), eq(vote.chatId, chatId)));
    }
    return await db.insert(vote).values({
      chatId,
      messageId,
      isUpvoted: type === "up",
    });
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to vote message");
  }
}

export async function getVotesByChatId({ id }: { id: string }) {
  try {
    return await db.select().from(vote).where(eq(vote.chatId, id));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get votes by chat id"
    );
  }
}

export async function saveDocument({
  id,
  title,
  kind,
  content,
  userId,
}: {
  id: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  userId: string;
}) {
  try {
    return await db
      .insert(document)
      .values({
        id,
        title,
        kind,
        content,
        userId,
        createdAt: new Date(),
      })
      .returning();
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to save document");
  }
}

export async function getDocumentsById({ id }: { id: string }) {
  try {
    const documents = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(asc(document.createdAt));

    return documents;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get documents by id"
    );
  }
}

export async function getDocumentById({ id }: { id: string }) {
  try {
    const [selectedDocument] = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(desc(document.createdAt));

    return selectedDocument;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get document by id"
    );
  }
}

export async function deleteDocumentsByIdAfterTimestamp({
  id,
  timestamp,
}: {
  id: string;
  timestamp: Date;
}) {
  try {
    await db
      .delete(suggestion)
      .where(
        and(
          eq(suggestion.documentId, id),
          gt(suggestion.documentCreatedAt, timestamp)
        )
      );

    return await db
      .delete(document)
      .where(and(eq(document.id, id), gt(document.createdAt, timestamp)))
      .returning();
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete documents by id after timestamp"
    );
  }
}

export async function saveSuggestions({
  suggestions,
}: {
  suggestions: Suggestion[];
}) {
  try {
    return await db.insert(suggestion).values(suggestions);
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to save suggestions"
    );
  }
}

export async function getSuggestionsByDocumentId({
  documentId,
}: {
  documentId: string;
}) {
  try {
    return await db
      .select()
      .from(suggestion)
      .where(eq(suggestion.documentId, documentId));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get suggestions by document id"
    );
  }
}

export async function getMessageById({ id }: { id: string }) {
  try {
    return await db.select().from(message).where(eq(message.id, id));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get message by id"
    );
  }
}

export async function deleteMessagesByChatIdAfterTimestamp({
  chatId,
  timestamp,
}: {
  chatId: string;
  timestamp: Date;
}) {
  try {
    const messagesToDelete = await db
      .select({ id: message.id })
      .from(message)
      .where(
        and(eq(message.chatId, chatId), gte(message.createdAt, timestamp))
      );

    const messageIds = messagesToDelete.map(
      (currentMessage) => currentMessage.id
    );

    if (messageIds.length > 0) {
      await db
        .delete(vote)
        .where(
          and(eq(vote.chatId, chatId), inArray(vote.messageId, messageIds))
        );

      return await db
        .delete(message)
        .where(
          and(eq(message.chatId, chatId), inArray(message.id, messageIds))
        );
    }
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete messages by chat id after timestamp"
    );
  }
}

export async function updateChatVisibilityById({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: "private" | "public";
}) {
  try {
    return await db.update(chat).set({ visibility }).where(eq(chat.id, chatId));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to update chat visibility by id"
    );
  }
}

export async function updateChatLastContextById({
  chatId,
  context,
}: {
  chatId: string;
  // Store merged server-enriched usage object
  context: AppUsage;
}) {
  try {
    return await db
      .update(chat)
      .set({ lastContext: context })
      .where(eq(chat.id, chatId));
  } catch (error) {
    console.warn("Failed to update lastContext for chat", chatId, error);
    return;
  }
}

export async function getMessageCountByUserId({
  id,
  differenceInHours,
}: {
  id: string;
  differenceInHours: number;
}) {
  try {
    const twentyFourHoursAgo = new Date(
      Date.now() - differenceInHours * 60 * 60 * 1000
    );

    const [stats] = await db
      .select({ count: count(message.id) })
      .from(message)
      .innerJoin(chat, eq(message.chatId, chat.id))
      .where(
        and(
          eq(chat.userId, id),
          gte(message.createdAt, twentyFourHoursAgo),
          eq(message.role, "user")
        )
      )
      .execute();

    return stats?.count ?? 0;
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error
        ? error.message
        : "Failed to get message count by user id"
    );
  }
}

export async function createStreamId({
  streamId,
  chatId,
}: {
  streamId: string;
  chatId: string;
}) {
  try {
    await db
      .insert(stream)
      .values({ id: streamId, chatId, createdAt: new Date() });
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to create stream id"
    );
  }
}

export async function getStreamIdsByChatId({ chatId }: { chatId: string }) {
  try {
    const streamIds = await db
      .select({ id: stream.id })
      .from(stream)
      .where(eq(stream.chatId, chatId))
      .orderBy(asc(stream.createdAt))
      .execute();

    return streamIds.map(({ id }) => id);
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get stream ids by chat id"
    );
  }
}
