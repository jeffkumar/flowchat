import { type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  foreignKey,
  index,
  json,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { AppUsage } from "../usage";

export const user = pgTable("User", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  email: varchar("email", { length: 64 }).notNull(),
  password: varchar("password", { length: 64 }),
});

export type User = InferSelectModel<typeof user>;

export const waitlistRequest = pgTable(
  "WaitlistRequest",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    email: varchar("email", { length: 64 }).notNull(),
    password: varchar("password", { length: 64 }),
    businessName: varchar("businessName", { length: 255 }).notNull(),
    phoneNumber: varchar("phoneNumber", { length: 20 }).notNull(),
    address: text("address").notNull(),
    country: varchar("country", { length: 100 }).notNull(),
    state: varchar("state", { length: 100 }),
    status: varchar("status", {
      enum: ["pending", "approved", "rejected"],
    })
      .notNull()
      .default("pending"),
    createdAt: timestamp("createdAt").notNull(),
    approvedAt: timestamp("approvedAt"),
    approvedBy: uuid("approvedBy").references(() => user.id),
  },
  (table) => ({
    emailIdx: uniqueIndex("waitlist_request_email_idx").on(table.email),
  })
);

export type WaitlistRequest = InferSelectModel<typeof waitlistRequest>;

export const project = pgTable(
  "Project",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    name: text("name").notNull(),
    createdBy: uuid("createdBy")
      .notNull()
      .references(() => user.id),
    organizationId: uuid("organizationId"),
    isDefault: boolean("isDefault").notNull().default(false),
    createdAt: timestamp("createdAt").notNull(),
  },
  (table) => ({
    defaultPerUser: uniqueIndex("project_default_per_user")
      .on(table.createdBy)
      .where(sql`${table.isDefault} = true`),
    namePerUser: uniqueIndex("project_name_per_user").on(
      table.createdBy,
      table.name
    ),
  })
);

export type Project = InferSelectModel<typeof project>;

export const projectDoc = pgTable(
  "ProjectDoc",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    projectId: uuid("projectId")
      .notNull()
      .references(() => project.id),
    createdBy: uuid("createdBy")
      .notNull()
      .references(() => user.id),
    organizationId: uuid("organizationId"),
    blobUrl: text("blobUrl").notNull(),
    filename: text("filename").notNull(),
    category: text("category"),
    description: text("description"),
    mimeType: text("mimeType").notNull(),
    sizeBytes: bigint("sizeBytes", { mode: "number" }).notNull(),
    turbopufferNamespace: text("turbopufferNamespace"),
    indexedAt: timestamp("indexedAt"),
    indexingError: text("indexingError"),
    metadata: jsonb("metadata"),
    documentType: varchar("documentType", {
      enum: ["general_doc", "bank_statement", "cc_statement", "invoice"],
    })
      .notNull()
      .default("general_doc"),
    parseStatus: varchar("parseStatus", {
      enum: ["pending", "parsed", "failed", "needs_review"],
    })
      .notNull()
      .default("pending"),
    parseError: text("parseError"),
    extractedJsonBlobUrl: text("extractedJsonBlobUrl"),
    schemaId: text("schemaId"),
    schemaVersion: bigint("schemaVersion", { mode: "number" }),
    currency: text("currency"),
    periodStart: date("periodStart"),
    periodEnd: date("periodEnd"),
    accountHint: text("accountHint"),
    entityName: text("entityName"),
    entityKind: varchar("entityKind", { enum: ["personal", "business"] }),
    createdAt: timestamp("createdAt").notNull(),
  },
  (table) => ({
    createdByIdx: index("project_doc_created_by_idx").on(table.createdBy),
    projectIdIdx: index("project_doc_project_id_idx").on(table.projectId),
    documentTypeIdx: index("project_doc_document_type_idx").on(
      table.projectId,
      table.documentType
    ),
    entityIdx: index("project_doc_entity_idx").on(
      table.projectId,
      table.entityKind,
      table.entityName
    ),
    parseStatusIdx: index("project_doc_parse_status_idx").on(table.parseStatus),
  })
);

export type ProjectDoc = InferSelectModel<typeof projectDoc>;

export const financialTransaction = pgTable(
  "financial_transactions",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => projectDoc.id, { onDelete: "cascade" }),
    txnDate: date("txn_date").notNull(),
    description: text("description"),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: text("currency"),
    merchant: text("merchant"),
    category: text("category"),
    balance: numeric("balance", { precision: 14, scale: 2 }),
    pageNum: bigint("page_num", { mode: "number" }),
    rowNum: bigint("row_num", { mode: "number" }),
    rowHash: text("row_hash").notNull(),
    txnHash: text("txn_hash"),
  },
  (table) => ({
    docIdx: index("ft_doc_idx").on(table.documentId),
    dateIdx: index("ft_date_idx").on(table.txnDate),
    txnHashIdx: index("ft_txn_hash_idx").on(table.txnHash),
    uniqueDocHash: uniqueIndex("ft_doc_hash_unique").on(
      table.documentId,
      table.rowHash
    ),
  })
);

export type FinancialTransaction = InferSelectModel<typeof financialTransaction>;

export const invoice = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .unique()
      .references(() => projectDoc.id, { onDelete: "cascade" }),
    vendor: text("vendor"),
    sender: text("sender"),
    recipient: text("recipient"),
    invoiceNumber: text("invoice_number"),
    invoiceDate: date("invoice_date"),
    dueDate: date("due_date"),
    subtotal: numeric("subtotal", { precision: 14, scale: 2 }),
    tax: numeric("tax", { precision: 14, scale: 2 }),
    total: numeric("total", { precision: 14, scale: 2 }),
    currency: text("currency"),
  },
  (table) => ({
    documentIdIdx: uniqueIndex("invoices_document_id_unique").on(table.documentId),
  })
);

export type Invoice = InferSelectModel<typeof invoice>;

export const invoiceLineItem = pgTable(
  "invoice_line_items",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoice.id, { onDelete: "cascade" }),
    description: text("description"),
    quantity: numeric("quantity", { precision: 14, scale: 4 }),
    unitPrice: numeric("unit_price", { precision: 14, scale: 4 }),
    amount: numeric("amount", { precision: 14, scale: 2 }),
    rowHash: text("row_hash").notNull(),
  },
  (table) => ({
    invoiceIdx: index("ili_invoice_idx").on(table.invoiceId),
    uniqueInvHash: uniqueIndex("ili_inv_hash_unique").on(
      table.invoiceId,
      table.rowHash
    ),
  })
);

export type InvoiceLineItem = InferSelectModel<typeof invoiceLineItem>;

export const chat = pgTable(
  "Chat",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    createdAt: timestamp("createdAt").notNull(),
    title: text("title").notNull(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
    projectId: uuid("projectId").references(() => project.id),
    visibility: varchar("visibility", { enum: ["public", "private"] })
      .notNull()
      .default("private"),
    lastContext: jsonb("lastContext").$type<AppUsage | null>(),
  },
  (table) => ({
    userIdCreatedAtIdx: index("chat_user_created_at_idx").on(
      table.userId,
      table.createdAt
    ),
  })
);

export type Chat = InferSelectModel<typeof chat>;

// DEPRECATED: The following schema is deprecated and will be removed in the future.
// Read the migration guide at https://chat-sdk.dev/docs/migration-guides/message-parts
export const messageDeprecated = pgTable("Message", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  chatId: uuid("chatId")
    .notNull()
    .references(() => chat.id),
  role: varchar("role").notNull(),
  content: json("content").notNull(),
  createdAt: timestamp("createdAt").notNull(),
});

export type MessageDeprecated = InferSelectModel<typeof messageDeprecated>;

export const message = pgTable("Message_v2", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  chatId: uuid("chatId")
    .notNull()
    .references(() => chat.id),
  role: varchar("role").notNull(),
  parts: json("parts").notNull(),
  attachments: json("attachments").notNull(),
  createdAt: timestamp("createdAt").notNull(),
});

export type DBMessage = InferSelectModel<typeof message>;

// DEPRECATED: The following schema is deprecated and will be removed in the future.
// Read the migration guide at https://chat-sdk.dev/docs/migration-guides/message-parts
export const voteDeprecated = pgTable(
  "Vote",
  {
    chatId: uuid("chatId")
      .notNull()
      .references(() => chat.id),
    messageId: uuid("messageId")
      .notNull()
      .references(() => messageDeprecated.id),
    isUpvoted: boolean("isUpvoted").notNull(),
  },
  (table) => {
    return {
      pk: primaryKey({ columns: [table.chatId, table.messageId] }),
    };
  }
);

export type VoteDeprecated = InferSelectModel<typeof voteDeprecated>;

export const vote = pgTable(
  "Vote_v2",
  {
    chatId: uuid("chatId")
      .notNull()
      .references(() => chat.id),
    messageId: uuid("messageId")
      .notNull()
      .references(() => message.id),
    isUpvoted: boolean("isUpvoted").notNull(),
  },
  (table) => {
    return {
      pk: primaryKey({ columns: [table.chatId, table.messageId] }),
    };
  }
);

export type Vote = InferSelectModel<typeof vote>;

export const document = pgTable(
  "Document",
  {
    id: uuid("id").notNull().defaultRandom(),
    createdAt: timestamp("createdAt").notNull(),
    title: text("title").notNull(),
    content: text("content"),
    kind: varchar("text", { enum: ["text", "code", "image", "sheet", "chart"] })
      .notNull()
      .default("text"),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
  },
  (table) => {
    return {
      pk: primaryKey({ columns: [table.id, table.createdAt] }),
    };
  }
);

export type Document = InferSelectModel<typeof document>;

export const suggestion = pgTable(
  "Suggestion",
  {
    id: uuid("id").notNull().defaultRandom(),
    documentId: uuid("documentId").notNull(),
    documentCreatedAt: timestamp("documentCreatedAt").notNull(),
    originalText: text("originalText").notNull(),
    suggestedText: text("suggestedText").notNull(),
    description: text("description"),
    isResolved: boolean("isResolved").notNull().default(false),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("createdAt").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id] }),
    documentRef: foreignKey({
      columns: [table.documentId, table.documentCreatedAt],
      foreignColumns: [document.id, document.createdAt],
    }),
  })
);

export type Suggestion = InferSelectModel<typeof suggestion>;

export const stream = pgTable(
  "Stream",
  {
    id: uuid("id").notNull().defaultRandom(),
    chatId: uuid("chatId").notNull(),
    createdAt: timestamp("createdAt").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id] }),
    chatRef: foreignKey({
      columns: [table.chatId],
      foreignColumns: [chat.id],
    }),
  })
);

export type Stream = InferSelectModel<typeof stream>;

export const integrationConnection = pgTable(
  "IntegrationConnection",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
    provider: varchar("provider", { enum: ["microsoft", "google"] }).notNull(),
    accountEmail: text("accountEmail"),
    providerAccountId: text("providerAccountId"),
    tenantId: text("tenantId"),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    accessTokenEnc: text("accessTokenEnc"),
    refreshTokenEnc: text("refreshTokenEnc"),
    expiresAt: timestamp("expiresAt"),
    revokedAt: timestamp("revokedAt"),
    createdAt: timestamp("createdAt").notNull(),
    updatedAt: timestamp("updatedAt").notNull(),
  },
  (table) => ({
    userProviderIdx: index("integration_connection_user_provider_idx").on(
      table.userId,
      table.provider
    ),
    providerAccountUnique: uniqueIndex(
      "integration_connection_provider_account_unique"
    ).on(table.provider, table.tenantId, table.providerAccountId),
  })
);

export type IntegrationConnection = InferSelectModel<typeof integrationConnection>;

export const projectIntegrationSource = pgTable(
  "ProjectIntegrationSource",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    projectId: uuid("projectId")
      .notNull()
      .references(() => project.id),
    createdBy: uuid("createdBy")
      .notNull()
      .references(() => user.id),
    provider: varchar("provider", { enum: ["microsoft", "google"] }).notNull(),
    resourceType: varchar("resourceType", {
      enum: ["sharepoint_folder", "google_drive_folder"],
    }).notNull(),
    siteId: text("siteId"),
    driveId: text("driveId"),
    itemId: text("itemId"),
    syncEnabled: boolean("syncEnabled").notNull().default(false),
    cursor: text("cursor"),
    createdAt: timestamp("createdAt").notNull(),
    updatedAt: timestamp("updatedAt").notNull(),
  },
  (table) => ({
    projectIdx: index("project_integration_source_project_idx").on(table.projectId),
    createdByIdx: index("project_integration_source_created_by_idx").on(
      table.createdBy
    ),
  })
);

export type ProjectIntegrationSource = InferSelectModel<
  typeof projectIntegrationSource
>;

export const projectUser = pgTable(
  "ProjectUser",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    projectId: uuid("projectId")
      .notNull()
      .references(() => project.id),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
    role: varchar("role", { enum: ["admin", "member"] }).notNull(),
    createdAt: timestamp("createdAt").notNull(),
  },
  (table) => ({
    projectUserIdx: uniqueIndex("project_user_idx").on(
      table.projectId,
      table.userId
    ),
  })
);

export type ProjectUser = InferSelectModel<typeof projectUser>;

export const projectInvitation = pgTable(
  "ProjectInvitation",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    projectId: uuid("projectId")
      .notNull()
      .references(() => project.id),
    email: varchar("email").notNull(),
    role: varchar("role", { enum: ["admin", "member"] }).notNull(),
    invitedBy: uuid("invitedBy")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("createdAt").notNull(),
  },
  (table) => ({
    projectInvitationIdx: uniqueIndex("project_invitation_idx").on(
      table.projectId,
      table.email
    ),
  })
);

export type ProjectInvitation = InferSelectModel<typeof projectInvitation>;
