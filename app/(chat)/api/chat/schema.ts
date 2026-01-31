import { z } from "zod";

const textPartSchema = z.object({
  type: z.enum(["text"]),
  text: z.string().min(1).max(20000),
});

const filePartSchema = z.object({
  type: z.enum(["file"]),
  mediaType: z.enum([
    "image/jpeg",
    "image/png",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/csv",
    "application/csv",
    "application/vnd.ms-excel",
  ]),
  name: z.string().min(1).max(100),
  url: z.string().url(),
});

const partSchema = z.union([textPartSchema, filePartSchema]);

export const postRequestBodySchema = z.object({
  id: z.string().uuid(),
  message: z.object({
    id: z.string().uuid(),
    role: z.enum(["user"]),
    parts: z.array(partSchema),
  }),
  selectedChatModel: z.enum([
    "chat-model",
    "chat-model-reasoning",
    "deepseek-v3",
  ]),
  selectedVisibilityType: z.enum(["public", "private"]),
  selectedAgentMode: z.string().optional(), // "project", "finance", or custom agent UUID
  projectId: z.string().uuid().optional(),
  sourceTypes: z.array(z.enum(["slack", "docs"])).optional(),
  ignoredDocIds: z.array(z.string()).optional(),
  retrievalRangePreset: z.enum(["all", "1d", "7d", "30d", "90d"]).optional(),
  retrievalTimeZone: z.string().min(1).max(64).optional(),
  selectedEntities: z
    .array(
      z.object({
        kind: z.enum(["personal", "business"]),
        name: z.string().nullable(),
      })
    )
    .optional(),
  selectedTimeRange: z
    .object({
      type: z.enum(["preset", "custom"]),
      label: z.string().min(1).max(100),
      date_start: z.string().optional(),
      date_end: z.string().optional(),
    })
    .optional(),
});

export type PostRequestBody = z.infer<typeof postRequestBodySchema>;
