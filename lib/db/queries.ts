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
  sql,
  type SQL,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { ArtifactKind } from "@/components/artifact";
import type { VisibilityType } from "@/lib/types";
import { ChatSDKError } from "../errors";
import type { AppUsage } from "../usage";
import { generateUUID } from "../utils";
import {
  type Chat,
  chat,
  type DBMessage,
  document,
  financialTransaction,
  integrationConnection,
  invoice,
  invoiceLineItem,
  message,
  type IntegrationConnection,
  type Project,
  type ProjectDoc,
  project,
  projectIntegrationSource,
  type ProjectIntegrationSource,
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

export async function deleteProjectById({
  projectId,
  userId,
}: {
  projectId: string;
  userId: string;
}) {
  try {
    const [projectToDelete] = await db
      .select()
      .from(project)
      .where(and(eq(project.id, projectId), eq(project.createdBy, userId)))
      .limit(1);

    if (!projectToDelete) {
      throw new Error("Project not found or not owned by user");
    }

    if (projectToDelete.isDefault) {
      throw new Error("Cannot delete default project");
    }

    await db.delete(projectDoc).where(eq(projectDoc.projectId, projectId));

    await db
      .update(chat)
      .set({ projectId: null })
      .where(eq(chat.projectId, projectId));

    const [deleted] = await db
      .delete(project)
      .where(eq(project.id, projectId))
      .returning();

    return deleted;
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to delete project"
    );
  }
}

export async function createProjectDoc({
  projectId,
  createdBy,
  organizationId,
  blobUrl,
  filename,
  category,
  description,
  mimeType,
  sizeBytes,
  turbopufferNamespace,
  metadata,
  documentType,
  parseStatus,
}: {
  projectId: string;
  createdBy: string;
  organizationId?: string | null;
  blobUrl: string;
  filename: string;
  category?: string | null;
  description?: string | null;
  mimeType: string;
  sizeBytes: number;
  turbopufferNamespace?: string | null;
  metadata?: Record<string, unknown> | null;
  documentType?: ProjectDoc["documentType"];
  parseStatus?: ProjectDoc["parseStatus"];
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
        category: category ?? null,
        description: description ?? null,
        mimeType,
        sizeBytes,
        turbopufferNamespace: turbopufferNamespace ?? null,
        metadata: metadata ?? null,
        documentType: documentType ?? "general_doc",
        parseStatus: parseStatus ?? "pending",
        createdAt: new Date(),
      })
      .returning();

    if (!created) {
      throw new Error("ProjectDoc insert returned no row");
    }

    return created;
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to create project doc"
    );
  }
}

export async function getProjectDocByProjectIdAndFilename({
  projectId,
  filename,
}: {
  projectId: string;
  filename: string;
}): Promise<ProjectDoc | null> {
  try {
    const [doc] = await db
      .select()
      .from(projectDoc)
      .where(and(eq(projectDoc.projectId, projectId), eq(projectDoc.filename, filename)))
      .limit(1);
    return doc ?? null;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get project doc by project id and filename"
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
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error
        ? error.message
        : "Failed to get project docs by project id"
    );
  }
}

export async function getProjectDocById({
  docId,
}: {
  docId: string;
}): Promise<ProjectDoc | null> {
  try {
    const [doc] = await db
      .select()
      .from(projectDoc)
      .where(eq(projectDoc.id, docId))
      .limit(1);
    return doc ?? null;
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to get project doc by id");
  }
}

export async function markProjectDocDeleting({ docId }: { docId: string }) {
  try {
    return await db
      .update(projectDoc)
      .set({
        indexingError: "Deleting",
      })
      .where(eq(projectDoc.id, docId));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to mark project doc deleting"
    );
  }
}

export async function deleteProjectDocById({ docId }: { docId: string }) {
  try {
    return await db.transaction(async (tx) => {
      const invoiceIds = await tx
        .select({ id: invoice.id })
        .from(invoice)
        .where(eq(invoice.documentId, docId));

      const ids = invoiceIds.map((r) => r.id);
      if (ids.length > 0) {
        await tx.delete(invoiceLineItem).where(inArray(invoiceLineItem.invoiceId, ids));
      }

      await tx.delete(invoice).where(eq(invoice.documentId, docId));
      await tx.delete(financialTransaction).where(eq(financialTransaction.documentId, docId));

      const [deleted] = await tx
        .delete(projectDoc)
        .where(eq(projectDoc.id, docId))
        .returning();
      return deleted ?? null;
    });
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to delete project doc by id");
  }
}

export async function deleteProjectDocsByProjectId({
  projectId,
}: {
  projectId: string;
}): Promise<{ deletedCount: number }> {
  try {
    return await db.transaction(async (tx) => {
      const docIds = await tx
        .select({ id: projectDoc.id })
        .from(projectDoc)
        .where(eq(projectDoc.projectId, projectId));

      const ids = docIds.map((r) => r.id);
      if (ids.length === 0) return { deletedCount: 0 };

      const invoiceIds = await tx
        .select({ id: invoice.id })
        .from(invoice)
        .where(inArray(invoice.documentId, ids));
      const invIds = invoiceIds.map((r) => r.id);
      if (invIds.length > 0) {
        await tx.delete(invoiceLineItem).where(inArray(invoiceLineItem.invoiceId, invIds));
      }

      await tx.delete(invoice).where(inArray(invoice.documentId, ids));
      await tx.delete(financialTransaction).where(inArray(financialTransaction.documentId, ids));

      const deleted = await tx
        .delete(projectDoc)
        .where(eq(projectDoc.projectId, projectId))
        .returning({ id: projectDoc.id });
      return { deletedCount: deleted.length };
    });
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete project docs by project id"
    );
  }
}

export async function deleteFinancialTransactionsByDocumentId({
  documentId,
}: {
  documentId: string;
}) {
  try {
    await db.delete(financialTransaction).where(eq(financialTransaction.documentId, documentId));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete financial transactions by document id"
    );
  }
}

export async function deleteInvoiceByDocumentId({ documentId }: { documentId: string }) {
  try {
    // invoice_line_items has ON DELETE CASCADE on invoice_id
    await db.delete(invoice).where(eq(invoice.documentId, documentId));
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to delete invoice by document id");
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
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error
        ? error.message
        : "Failed to mark project doc indexed"
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
  } catch (caught) {
    throw new ChatSDKError(
      "bad_request:database",
      caught instanceof Error
        ? caught.message
        : "Failed to mark project doc indexing error"
    );
  }
}

export async function upsertIntegrationConnection({
  userId,
  provider,
  accountEmail,
  providerAccountId,
  tenantId,
  scopes,
  accessTokenEnc,
  refreshTokenEnc,
  expiresAt,
}: {
  userId: string;
  provider: "microsoft" | "google";
  accountEmail?: string | null;
  providerAccountId?: string | null;
  tenantId?: string | null;
  scopes: string[];
  accessTokenEnc?: string | null;
  refreshTokenEnc?: string | null;
  expiresAt?: Date | null;
}): Promise<IntegrationConnection> {
  try {
    const now = new Date();
    const [created] = await db
      .insert(integrationConnection)
      .values({
        userId,
        provider,
        accountEmail: accountEmail ?? null,
        providerAccountId: providerAccountId ?? null,
        tenantId: tenantId ?? null,
        scopes,
        accessTokenEnc: accessTokenEnc ?? null,
        refreshTokenEnc: refreshTokenEnc ?? null,
        expiresAt: expiresAt ?? null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          integrationConnection.provider,
          integrationConnection.tenantId,
          integrationConnection.providerAccountId,
        ],
        set: {
          userId,
          accountEmail: accountEmail ?? null,
          scopes,
          accessTokenEnc: accessTokenEnc ?? null,
          refreshTokenEnc: refreshTokenEnc ?? null,
          expiresAt: expiresAt ?? null,
          revokedAt: null,
          updatedAt: now,
        },
      })
      .returning();

    if (!created) {
      throw new Error("IntegrationConnection upsert returned no row");
    }

    return created;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to upsert integration connection"
    );
  }
}

export async function getIntegrationConnectionForUser({
  userId,
  provider,
}: {
  userId: string;
  provider: "microsoft" | "google";
}): Promise<IntegrationConnection | null> {
  try {
    const [found] = await db
      .select()
      .from(integrationConnection)
      .where(
        and(
          eq(integrationConnection.userId, userId),
          eq(integrationConnection.provider, provider)
        )
      )
      .orderBy(desc(integrationConnection.updatedAt))
      .limit(1);
    return found ?? null;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get integration connection"
    );
  }
}

export async function revokeIntegrationConnection({
  connectionId,
}: {
  connectionId: string;
}) {
  try {
    return await db
      .update(integrationConnection)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(integrationConnection.id, connectionId));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to revoke integration connection"
    );
  }
}

export async function createProjectIntegrationSource({
  projectId,
  createdBy,
  provider,
  resourceType,
  siteId,
  driveId,
  itemId,
}: {
  projectId: string;
  createdBy: string;
  provider: "microsoft" | "google";
  resourceType: "sharepoint_folder" | "google_drive_folder";
  siteId?: string | null;
  driveId?: string | null;
  itemId?: string | null;
}): Promise<ProjectIntegrationSource> {
  try {
    const now = new Date();
    const [created] = await db
      .insert(projectIntegrationSource)
      .values({
        projectId,
        createdBy,
        provider,
        resourceType,
        siteId: siteId ?? null,
        driveId: driveId ?? null,
        itemId: itemId ?? null,
        syncEnabled: false,
        cursor: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!created) {
      throw new Error("ProjectIntegrationSource insert returned no row");
    }

    return created;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to create project integration source"
    );
  }
}

export async function saveChat({
  id,
  userId,
  projectId,
  title,
  visibility,
}: {
  id: string;
  userId: string;
  projectId?: string;
  title: string;
  visibility: VisibilityType;
}) {
  try {
    return await db.insert(chat).values({
      id,
      createdAt: new Date(),
      userId,
      projectId,
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
  projectId,
  limit,
  startingAfter,
  endingBefore,
}: {
  id: string;
  projectId?: string;
  limit: number;
  startingAfter: string | null;
  endingBefore: string | null;
}) {
  try {
    const extendedLimit = limit + 1;

    const query = (whereCondition?: SQL<any>) => {
      const conditions: (SQL<any> | undefined)[] = [
        eq(chat.userId, id),
        projectId ? eq(chat.projectId, projectId) : undefined,
        whereCondition,
      ];

      return db
        .select()
        .from(chat)
        .where(and(...conditions))
        .orderBy(desc(chat.createdAt))
        .limit(extendedLimit);
    };

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

export async function getProjectDocByMicrosoftItemId({
  projectId,
  itemId,
}: {
  projectId: string;
  itemId: string;
}): Promise<ProjectDoc | null> {
  try {
    const [doc] = await db
      .select()
      .from(projectDoc)
      .where(
        and(
          eq(projectDoc.projectId, projectId),
          sql`${projectDoc.metadata}->>'itemId' = ${itemId}`
        )
      )
      .limit(1);
    return doc ?? null;
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error
        ? error.message
        : "Failed to get project doc by microsoft item id"
    );
  }
}

export async function updateProjectDoc({
  docId,
  data,
}: {
  docId: string;
  data: Partial<ProjectDoc>;
}) {
  try {
    const [updated] = await db
      .update(projectDoc)
      .set(data)
      .where(eq(projectDoc.id, docId))
      .returning();
    return updated;
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to update project doc"
    );
  }
}

export async function insertFinancialTransactions({
  documentId,
  rows,
}: {
  documentId: string;
  rows: Array<{
    txnDate: string; // YYYY-MM-DD
    description?: string | null;
    amount: string; // decimal string
    currency?: string | null;
    merchant?: string | null;
    category?: string | null;
    balance?: string | null;
    pageNum?: number | null;
    rowNum?: number | null;
    rowHash: string;
    txnHash?: string | null;
  }>;
}): Promise<{ insertedCount: number }> {
  try {
    if (rows.length === 0) return { insertedCount: 0 };

    const inserted = await db
      .insert(financialTransaction)
      .values(
        rows.map((r) => ({
          documentId,
          txnDate: r.txnDate,
          description: r.description ?? null,
          amount: r.amount,
          currency: r.currency ?? null,
          merchant: r.merchant ?? null,
          category: r.category ?? null,
          balance: r.balance ?? null,
          pageNum: r.pageNum ?? null,
          rowNum: r.rowNum ?? null,
          rowHash: r.rowHash,
          txnHash: r.txnHash ?? null,
        }))
      )
      .onConflictDoNothing({
        target: [financialTransaction.documentId, financialTransaction.rowHash],
      })
      .returning({ id: financialTransaction.id });

    return { insertedCount: inserted.length };
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to insert financial transactions"
    );
  }
}

export async function upsertInvoiceForDocument({
  documentId,
  data,
}: {
  documentId: string;
  data: {
    vendor?: string | null;
    invoiceNumber?: string | null;
    invoiceDate?: string | null; // YYYY-MM-DD
    dueDate?: string | null; // YYYY-MM-DD
    subtotal?: string | null;
    tax?: string | null;
    total?: string | null;
    currency?: string | null;
  };
}) {
  try {
    const [row] = await db
      .insert(invoice)
      .values({
        documentId,
        vendor: data.vendor ?? null,
        invoiceNumber: data.invoiceNumber ?? null,
        invoiceDate: data.invoiceDate ?? null,
        dueDate: data.dueDate ?? null,
        subtotal: data.subtotal ?? null,
        tax: data.tax ?? null,
        total: data.total ?? null,
        currency: data.currency ?? null,
      })
      .onConflictDoUpdate({
        target: [invoice.documentId],
        set: {
          vendor: data.vendor ?? null,
          invoiceNumber: data.invoiceNumber ?? null,
          invoiceDate: data.invoiceDate ?? null,
          dueDate: data.dueDate ?? null,
          subtotal: data.subtotal ?? null,
          tax: data.tax ?? null,
          total: data.total ?? null,
          currency: data.currency ?? null,
        },
      })
      .returning();

    if (!row) {
      throw new Error("Invoice upsert returned no row");
    }

    return row;
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to upsert invoice"
    );
  }
}

export async function insertInvoiceLineItems({
  invoiceId,
  rows,
}: {
  invoiceId: string;
  rows: Array<{
    description?: string | null;
    quantity?: string | null;
    unitPrice?: string | null;
    amount?: string | null;
    rowHash: string;
  }>;
}): Promise<{ insertedCount: number }> {
  try {
    if (rows.length === 0) return { insertedCount: 0 };

    const inserted = await db
      .insert(invoiceLineItem)
      .values(
        rows.map((r) => ({
          invoiceId,
          description: r.description ?? null,
          quantity: r.quantity ?? null,
          unitPrice: r.unitPrice ?? null,
          amount: r.amount ?? null,
          rowHash: r.rowHash,
        }))
      )
      .onConflictDoNothing({
        target: [invoiceLineItem.invoiceId, invoiceLineItem.rowHash],
      })
      .returning({ id: invoiceLineItem.id });

    return { insertedCount: inserted.length };
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to insert invoice line items"
    );
  }
}

type FinanceDocumentType = "bank_statement" | "cc_statement" | "invoice";

type FinanceQueryFilters = {
  doc_ids?: string[];
  date_start?: string;
  date_end?: string;
  vendor_contains?: string;
  amount_min?: number;
  amount_max?: number;
};

function buildDocIdFilter(docIds: string[] | undefined) {
  if (!Array.isArray(docIds) || docIds.length === 0) return null;
  return inArray(projectDoc.id, docIds);
}

function buildDateRangeFilter({
  documentType,
  dateStart,
  dateEnd,
}: {
  documentType: FinanceDocumentType;
  dateStart?: string;
  dateEnd?: string;
}) {
  const clauses: SQL[] = [];
  if (!dateStart && !dateEnd) return clauses;

  if (documentType === "invoice") {
    if (typeof dateStart === "string") {
      clauses.push(sql`${invoice.invoiceDate} >= ${dateStart}::date`);
    }
    if (typeof dateEnd === "string") {
      clauses.push(sql`${invoice.invoiceDate} < ${dateEnd}::date`);
    }
    return clauses;
  }

  if (typeof dateStart === "string") {
    clauses.push(sql`${financialTransaction.txnDate} >= ${dateStart}::date`);
  }
  if (typeof dateEnd === "string") {
    clauses.push(sql`${financialTransaction.txnDate} < ${dateEnd}::date`);
  }
  return clauses;
}

function buildAmountRangeFilter({
  amountMin,
  amountMax,
}: {
  amountMin?: number;
  amountMax?: number;
}) {
  const clauses: SQL[] = [];
  if (typeof amountMin === "number" && Number.isFinite(amountMin)) {
    clauses.push(sql`${financialTransaction.amount} >= ${amountMin}`);
  }
  if (typeof amountMax === "number" && Number.isFinite(amountMax)) {
    clauses.push(sql`${financialTransaction.amount} <= ${amountMax}`);
  }
  return clauses;
}

function buildVendorContainsFilter({
  documentType,
  vendorContains,
}: {
  documentType: FinanceDocumentType;
  vendorContains?: string;
}) {
  if (typeof vendorContains !== "string") return null;
  const needle = vendorContains.trim();
  if (!needle) return null;
  const like = `%${needle}%`;

  if (documentType === "invoice") {
    return sql`${invoice.vendor} ILIKE ${like}`;
  }
  return sql`${financialTransaction.description} ILIKE ${like}`;
}

export async function financeSum({
  userId,
  documentType,
  filters,
}: {
  userId: string;
  documentType: FinanceDocumentType;
  filters?: FinanceQueryFilters;
}) {
  try {
    const docIdFilter = buildDocIdFilter(filters?.doc_ids);
    const vendorFilter = buildVendorContainsFilter({
      documentType,
      vendorContains: filters?.vendor_contains,
    });
    const dateClauses = buildDateRangeFilter({
      documentType,
      dateStart: filters?.date_start,
      dateEnd: filters?.date_end,
    });

    if (documentType === "invoice") {
      const whereClauses: SQL[] = [
        eq(project.createdBy, userId),
        eq(projectDoc.documentType, "invoice"),
      ];
      if (docIdFilter) whereClauses.push(docIdFilter);
      if (vendorFilter) whereClauses.push(vendorFilter);
      whereClauses.push(...dateClauses);

      const [row] = await db
        .select({
          total: sql<string>`COALESCE(SUM(${invoice.total}), 0)::text`.as("total"),
          count: sql<number>`COUNT(*)::int`.as("count"),
        })
        .from(invoice)
        .innerJoin(projectDoc, eq(invoice.documentId, projectDoc.id))
        .innerJoin(project, eq(projectDoc.projectId, project.id))
        .where(and(...whereClauses));

      return {
        query_type: "sum" as const,
        document_type: "invoice" as const,
        total: row?.total ?? "0",
        count: row?.count ?? 0,
        provenance: {
          source: "postgres" as const,
          doc_ids: filters?.doc_ids ?? null,
        },
      };
    }

    const whereClauses: SQL[] = [
      eq(project.createdBy, userId),
      eq(projectDoc.documentType, documentType),
    ];
    if (docIdFilter) whereClauses.push(docIdFilter);
    if (vendorFilter) whereClauses.push(vendorFilter);
    whereClauses.push(...dateClauses);
    whereClauses.push(
      ...buildAmountRangeFilter({
        amountMin: filters?.amount_min,
        amountMax: filters?.amount_max,
      })
    );

    const whereSql = and(...whereClauses);
    const dedupeKey = sql<string>`COALESCE(${financialTransaction.txnHash}, (${financialTransaction.documentId}::text || '|' || ${financialTransaction.rowHash}))`;

    const [row] = await db.execute(sql`
      SELECT
        COALESCE(SUM(t.amount), 0)::text AS total,
        COUNT(*)::int AS count
      FROM (
        SELECT DISTINCT ON (${dedupeKey})
          ${financialTransaction.amount} AS amount
        FROM ${financialTransaction}
        INNER JOIN ${projectDoc} ON ${eq(financialTransaction.documentId, projectDoc.id)}
        INNER JOIN ${project} ON ${eq(projectDoc.projectId, project.id)}
        WHERE ${whereSql}
        ORDER BY ${dedupeKey} ASC, ${projectDoc.createdAt} ASC, ${financialTransaction.id} ASC
      ) t
    `);

    // Supporting IDs (capped, deduped)
    const supporting = await db.execute(sql`
      SELECT t.id
      FROM (
        SELECT DISTINCT ON (${dedupeKey})
          ${financialTransaction.id} AS id,
          ${financialTransaction.txnDate} AS txn_date
        FROM ${financialTransaction}
        INNER JOIN ${projectDoc} ON ${eq(financialTransaction.documentId, projectDoc.id)}
        INNER JOIN ${project} ON ${eq(projectDoc.projectId, project.id)}
        WHERE ${whereSql}
        ORDER BY ${dedupeKey} ASC, ${projectDoc.createdAt} ASC, ${financialTransaction.id} ASC
      ) t
      ORDER BY t.txn_date ASC, t.id ASC
      LIMIT 500
    `);

    return {
      query_type: "sum" as const,
      document_type: documentType,
      total: row?.total ?? "0",
      count: row?.count ?? 0,
      supporting_ids: supporting.map((r) => (r as { id: string }).id),
      provenance: {
        source: "postgres" as const,
        doc_ids: filters?.doc_ids ?? null,
      },
    };
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to run finance sum"
    );
  }
}

export async function financeList({
  userId,
  documentType,
  filters,
}: {
  userId: string;
  documentType: FinanceDocumentType;
  filters?: FinanceQueryFilters;
}) {
  try {
    const docIdFilter = buildDocIdFilter(filters?.doc_ids);
    const vendorFilter = buildVendorContainsFilter({
      documentType,
      vendorContains: filters?.vendor_contains,
    });
    const dateClauses = buildDateRangeFilter({
      documentType,
      dateStart: filters?.date_start,
      dateEnd: filters?.date_end,
    });

    if (documentType === "invoice") {
      const whereClauses: SQL[] = [
        eq(project.createdBy, userId),
        eq(projectDoc.documentType, "invoice"),
      ];
      if (docIdFilter) whereClauses.push(docIdFilter);
      if (vendorFilter) whereClauses.push(vendorFilter);
      whereClauses.push(...dateClauses);

      const rows = await db
        .select({
          id: invoice.id,
          vendor: invoice.vendor,
          invoiceNumber: invoice.invoiceNumber,
          invoiceDate: invoice.invoiceDate,
          dueDate: invoice.dueDate,
          total: invoice.total,
          currency: invoice.currency,
          documentId: invoice.documentId,
        })
        .from(invoice)
        .innerJoin(projectDoc, eq(invoice.documentId, projectDoc.id))
        .innerJoin(project, eq(projectDoc.projectId, project.id))
        .where(and(...whereClauses))
        .orderBy(desc(invoice.invoiceDate), desc(invoice.id))
        .limit(500);

      return {
        query_type: "list" as const,
        document_type: "invoice" as const,
        rows,
        provenance: { source: "postgres" as const },
      };
    }

    const whereClauses: SQL[] = [
      eq(project.createdBy, userId),
      eq(projectDoc.documentType, documentType),
    ];
    if (docIdFilter) whereClauses.push(docIdFilter);
    if (vendorFilter) whereClauses.push(vendorFilter);
    whereClauses.push(...dateClauses);
    whereClauses.push(
      ...buildAmountRangeFilter({
        amountMin: filters?.amount_min,
        amountMax: filters?.amount_max,
      })
    );

    const whereSql = and(...whereClauses);
    const dedupeKey = sql<string>`COALESCE(${financialTransaction.txnHash}, (${financialTransaction.documentId}::text || '|' || ${financialTransaction.rowHash}))`;

    const rows = await db.execute(sql`
      SELECT
        t.id,
        t.document_id AS "documentId",
        t.txn_date AS "txnDate",
        t.description,
        t.amount,
        t.currency
      FROM (
        SELECT DISTINCT ON (${dedupeKey})
          ${financialTransaction.id} AS id,
          ${financialTransaction.documentId} AS document_id,
          ${financialTransaction.txnDate} AS txn_date,
          ${financialTransaction.description} AS description,
          ${financialTransaction.amount} AS amount,
          ${financialTransaction.currency} AS currency
        FROM ${financialTransaction}
        INNER JOIN ${projectDoc} ON ${eq(financialTransaction.documentId, projectDoc.id)}
        INNER JOIN ${project} ON ${eq(projectDoc.projectId, project.id)}
        WHERE ${whereSql}
        ORDER BY ${dedupeKey} ASC, ${projectDoc.createdAt} ASC, ${financialTransaction.id} ASC
      ) t
      ORDER BY t.txn_date DESC, t.id DESC
      LIMIT 500
    `);

    return {
      query_type: "list" as const,
      document_type: documentType,
      rows: rows as unknown as Array<{
        id: string;
        documentId: string;
        txnDate: string;
        description: string | null;
        amount: string;
        currency: string | null;
      }>,
      provenance: { source: "postgres" as const },
    };
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to run finance list"
    );
  }
}

export async function financeGroupByMonth({
  userId,
  documentType,
  filters,
}: {
  userId: string;
  documentType: FinanceDocumentType;
  filters?: FinanceQueryFilters;
}) {
  try {
    const docIdFilter = buildDocIdFilter(filters?.doc_ids);
    const vendorFilter = buildVendorContainsFilter({
      documentType,
      vendorContains: filters?.vendor_contains,
    });
    const dateClauses = buildDateRangeFilter({
      documentType,
      dateStart: filters?.date_start,
      dateEnd: filters?.date_end,
    });

    if (documentType === "invoice") {
      const whereClauses: SQL[] = [
        eq(project.createdBy, userId),
        eq(projectDoc.documentType, "invoice"),
      ];
      if (docIdFilter) whereClauses.push(docIdFilter);
      if (vendorFilter) whereClauses.push(vendorFilter);
      whereClauses.push(...dateClauses);

      const rows = await db
        .select({
          month: sql<string>`to_char(date_trunc('month', ${invoice.invoiceDate}), 'YYYY-MM')`.as(
            "month"
          ),
          total: sql<string>`COALESCE(SUM(${invoice.total}), 0)::text`.as("total"),
          count: sql<number>`COUNT(*)::int`.as("count"),
        })
        .from(invoice)
        .innerJoin(projectDoc, eq(invoice.documentId, projectDoc.id))
        .innerJoin(project, eq(projectDoc.projectId, project.id))
        .where(and(...whereClauses))
        .groupBy(sql`date_trunc('month', ${invoice.invoiceDate})`)
        .orderBy(sql`date_trunc('month', ${invoice.invoiceDate})`);

      return {
        query_type: "group_by_month" as const,
        document_type: "invoice" as const,
        rows,
        provenance: { source: "postgres" as const },
      };
    }

    const whereClauses: SQL[] = [
      eq(project.createdBy, userId),
      eq(projectDoc.documentType, documentType),
    ];
    if (docIdFilter) whereClauses.push(docIdFilter);
    if (vendorFilter) whereClauses.push(vendorFilter);
    whereClauses.push(...dateClauses);
    whereClauses.push(
      ...buildAmountRangeFilter({
        amountMin: filters?.amount_min,
        amountMax: filters?.amount_max,
      })
    );

    const whereSql = and(...whereClauses);
    const dedupeKey = sql<string>`COALESCE(${financialTransaction.txnHash}, (${financialTransaction.documentId}::text || '|' || ${financialTransaction.rowHash}))`;

    const rows = await db.execute(sql`
      SELECT
        to_char(date_trunc('month', t.txn_date), 'YYYY-MM') AS month,
        COALESCE(SUM(t.amount), 0)::text AS total,
        COUNT(*)::int AS count
      FROM (
        SELECT DISTINCT ON (${dedupeKey})
          ${financialTransaction.txnDate} AS txn_date,
          ${financialTransaction.amount} AS amount
        FROM ${financialTransaction}
        INNER JOIN ${projectDoc} ON ${eq(financialTransaction.documentId, projectDoc.id)}
        INNER JOIN ${project} ON ${eq(projectDoc.projectId, project.id)}
        WHERE ${whereSql}
        ORDER BY ${dedupeKey} ASC, ${projectDoc.createdAt} ASC, ${financialTransaction.id} ASC
      ) t
      GROUP BY date_trunc('month', t.txn_date)
      ORDER BY date_trunc('month', t.txn_date)
    `);

    return {
      query_type: "group_by_month" as const,
      document_type: documentType,
      rows: rows as unknown as Array<{ month: string; total: string; count: number }>,
      provenance: { source: "postgres" as const },
    };
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to run finance group_by_month"
    );
  }
}

export async function financeGroupByMerchant({
  userId,
  documentType,
  filters,
}: {
  userId: string;
  documentType: FinanceDocumentType;
  filters?: FinanceQueryFilters;
}) {
  try {
    const docIdFilter = buildDocIdFilter(filters?.doc_ids);
    const vendorFilter = buildVendorContainsFilter({
      documentType,
      vendorContains: filters?.vendor_contains,
    });
    const dateClauses = buildDateRangeFilter({
      documentType,
      dateStart: filters?.date_start,
      dateEnd: filters?.date_end,
    });

    if (documentType === "invoice") {
      const whereClauses: SQL[] = [
        eq(project.createdBy, userId),
        eq(projectDoc.documentType, "invoice"),
      ];
      if (docIdFilter) whereClauses.push(docIdFilter);
      if (vendorFilter) whereClauses.push(vendorFilter);
      whereClauses.push(...dateClauses);

      const rows = await db
        .select({
          merchant: invoice.vendor,
          total: sql<string>`COALESCE(SUM(${invoice.total}), 0)::text`.as("total"),
          count: sql<number>`COUNT(*)::int`.as("count"),
        })
        .from(invoice)
        .innerJoin(projectDoc, eq(invoice.documentId, projectDoc.id))
        .innerJoin(project, eq(projectDoc.projectId, project.id))
        .where(and(...whereClauses))
        .groupBy(invoice.vendor)
        .orderBy(desc(sql`COALESCE(SUM(${invoice.total}), 0)`))
        .limit(200);

      return {
        query_type: "group_by_merchant" as const,
        document_type: "invoice" as const,
        rows,
        provenance: { source: "postgres" as const },
      };
    }

    const whereClauses: SQL[] = [
      eq(project.createdBy, userId),
      eq(projectDoc.documentType, documentType),
    ];
    if (docIdFilter) whereClauses.push(docIdFilter);
    if (vendorFilter) whereClauses.push(vendorFilter);
    whereClauses.push(...dateClauses);
    whereClauses.push(
      ...buildAmountRangeFilter({
        amountMin: filters?.amount_min,
        amountMax: filters?.amount_max,
      })
    );

    const whereSql = and(...whereClauses);
    const dedupeKey = sql<string>`COALESCE(${financialTransaction.txnHash}, (${financialTransaction.documentId}::text || '|' || ${financialTransaction.rowHash}))`;

    const rows = await db.execute(sql`
      SELECT
        t.merchant,
        COALESCE(SUM(t.amount), 0)::text AS total,
        COUNT(*)::int AS count
      FROM (
        SELECT DISTINCT ON (${dedupeKey})
          ${financialTransaction.description} AS merchant,
          ${financialTransaction.amount} AS amount
        FROM ${financialTransaction}
        INNER JOIN ${projectDoc} ON ${eq(financialTransaction.documentId, projectDoc.id)}
        INNER JOIN ${project} ON ${eq(projectDoc.projectId, project.id)}
        WHERE ${whereSql}
        ORDER BY ${dedupeKey} ASC, ${projectDoc.createdAt} ASC, ${financialTransaction.id} ASC
      ) t
      GROUP BY t.merchant
      ORDER BY COALESCE(SUM(t.amount), 0) DESC
      LIMIT 200
    `);

    return {
      query_type: "group_by_merchant" as const,
      document_type: documentType,
      rows: rows as unknown as Array<{ merchant: string | null; total: string; count: number }>,
      provenance: { source: "postgres" as const },
    };
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to run finance group_by_merchant"
    );
  }
}
