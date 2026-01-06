import type { Session } from "next-auth";
import { z } from "zod";
import {
  FrontlineDecisionSchema,
  type FrontlineDecision,
} from "@/lib/ai/agents/types";

const FrontlineInputSchema = z.object({
  question: z.string().min(1).max(4000),
  retrieved_context: z.string().max(50_000).optional(),
});
export type FrontlineInput = z.infer<typeof FrontlineInputSchema>;

export async function decideFrontlineRouting({
  _session,
  input,
}: {
  _session: Session;
  input: FrontlineInput;
}): Promise<FrontlineDecision> {
  const parsed = FrontlineInputSchema.parse(input);
  const q = parsed.question.toLowerCase();
  const hasRetrievedContext =
    typeof parsed.retrieved_context === "string" && parsed.retrieved_context.trim().length > 0;

  const needs_finance =
    /\b(sum|total|add\s+up|aggregate|spent|spend|spending|expense|expenses|income|revenue|deposits?|charges?|transactions?|invoice)\b/i.test(
      q
    ) ||
    /\b(amex|american\s+express|credit\s+card|card)\b/i.test(q) ||
    /\b(merchant|merchants|where\s+did\s+i\s+buy|where\s+am\s+i\s+spending|buy)\b/i.test(q) ||
    /\b(coffee|grocer|restaurant|dining|travel|gas|fuel|subscriptions?)\b/i.test(q);

  // If finance is requested but entity isn't explicit, ProjectAgent can clarify.
  const mentionsEntity = /\b(personal|business)\b/i.test(q);
  const needs_project = needs_finance && !mentionsEntity;

  // Only request citations when we're not doing finance math and we have retrieved context.
  const needs_citations = hasRetrievedContext && !needs_finance;

  return FrontlineDecisionSchema.parse({
    needs_finance,
    needs_project,
    needs_citations,
    questions_for_user: [],
  });
}


