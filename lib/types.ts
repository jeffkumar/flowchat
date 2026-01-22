import type { InferUITool, UIMessage } from "ai";
import { z } from "zod";
import type { ArtifactKind } from "@/components/artifact";
import type { createDocument } from "./ai/tools/create-document";
import type { financeQuery } from "./ai/tools/finance-query";
import type { getWeather } from "./ai/tools/get-weather";
import type { requestSuggestions } from "./ai/tools/request-suggestions";
import type { updateDocument } from "./ai/tools/update-document";
import type { Suggestion } from "./db/schema";
import type { AppUsage } from "./usage";

export type DataPart = { type: "append-message"; message: string };

export type RetrievedSource = {
  sourceType: string;
  docId?: string;
  filename?: string;
  channelName?: string;
  category?: string;
  description?: string;
  blobUrl?: string;
  content?: string;
};

export type ChartDocumentAnnotation = {
  type: "chart-document";
  data: {
    documentId: string;
    title: string;
  };
};

export type ChatAnnotation =
  | { type: "sources"; data: RetrievedSource[] }
  | ChartDocumentAnnotation
  | { type: string; data: unknown };

export const messageMetadataSchema = z.object({
  createdAt: z.string(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

type weatherTool = InferUITool<typeof getWeather>;
type createDocumentTool = InferUITool<ReturnType<typeof createDocument>>;
type financeQueryTool = InferUITool<ReturnType<typeof financeQuery>>;
type updateDocumentTool = InferUITool<ReturnType<typeof updateDocument>>;
type requestSuggestionsTool = InferUITool<
  ReturnType<typeof requestSuggestions>
>;

export type ChatTools = {
  getWeather: weatherTool;
  createDocument: createDocumentTool;
  financeQuery: financeQueryTool;
  updateDocument: updateDocumentTool;
  requestSuggestions: requestSuggestionsTool;
};

export type EntityOption = {
  kind: "personal" | "business";
  name: string | null;
};

export type CustomUIDataTypes = {
  textDelta: string;
  imageDelta: string;
  sheetDelta: string;
  codeDelta: string;
  suggestion: Suggestion;
  appendMessage: string;
  id: string;
  title: string;
  kind: ArtifactKind;
  clear: null;
  finish: null;
  usage: AppUsage;
  sources: RetrievedSource[];
  chartDocument: { id: string; title: string; kind: "chart" };
  agentStatus: { agent: string; message: string };
  entitySelector: {
    availableEntities: EntityOption[];
    questionId?: string;
  };
};

export type ChatMessage = UIMessage<MessageMetadata, CustomUIDataTypes, ChatTools> & {
  annotations?: ChatAnnotation[];
};

export type Attachment = {
  name: string;
  url: string;
  contentType: string;
  isLoading?: boolean;
};

export type VisibilityType = "public" | "private";
