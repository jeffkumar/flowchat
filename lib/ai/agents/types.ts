import { z } from "zod";

export const AgentKindSchema = z.enum(["finance", "citations", "project"]);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const AgentConfidenceSchema = z.enum(["low", "medium", "high"]);
export type AgentConfidence = z.infer<typeof AgentConfidenceSchema>;

export const AgentToolCallSchema = z.object({
  toolName: z.string().min(1).max(200),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
});
export type AgentToolCall = z.infer<typeof AgentToolCallSchema>;

export const AgentCitationSchema = z.object({
  sourceIndex: z.number().int().min(1),
  snippet: z.string().min(1).max(800).optional(),
});
export type AgentCitation = z.infer<typeof AgentCitationSchema>;

export const EntityOptionSchema = z.object({
  kind: z.enum(["personal", "business"]),
  name: z.string().nullable(),
});
export type EntityOption = z.infer<typeof EntityOptionSchema>;

export const ChartPayloadRowSchema = z.object({
  label: z.string().min(1).max(120),
  value: z.number(),
  count: z.number().int().nonnegative().optional(),
});
export type ChartPayloadRow = z.infer<typeof ChartPayloadRowSchema>;

export const ChartPayloadSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1).max(140),
  breakdown: z.enum(["category", "month", "merchant", "description"]),
  unit: z.literal("USD"),
  rows: z.array(ChartPayloadRowSchema).max(250),
});
export type ChartPayload = z.infer<typeof ChartPayloadSchema>;

export const SpecialistAgentResponseSchema = z.object({
  kind: AgentKindSchema,
  answer_draft: z.string(),
  questions_for_user: z.array(z.string().min(1).max(300)).default([]),
  assumptions: z.array(z.string().min(1).max(300)).default([]),
  tool_calls: z.array(AgentToolCallSchema).default([]),
  citations: z.array(AgentCitationSchema).default([]),
  confidence: AgentConfidenceSchema.default("medium"),
  chart_payload: ChartPayloadSchema.optional(),
  needs_entity_selection: z
    .object({
      available_entities: z.array(EntityOptionSchema),
    })
    .optional(),
});

export type SpecialistAgentResponse = z.infer<typeof SpecialistAgentResponseSchema>;

export const FrontlineDecisionSchema = z.object({
  needs_finance: z.boolean().default(false),
  needs_citations: z.boolean().default(false),
  needs_project: z.boolean().default(false),
  // If the frontline can directly answer without delegation:
  direct_answer: z.string().optional(),
  // If we should ask user a question before proceeding:
  questions_for_user: z.array(z.string().min(1).max(300)).default([]),
});
export type FrontlineDecision = z.infer<typeof FrontlineDecisionSchema>;


