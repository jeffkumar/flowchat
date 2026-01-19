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

  // Only route to FinanceAgent for finance *data* queries (totals/lists/breakdowns).
  // General planning ("how do I afford X", "what should I do financially") should stay in main chat.
  const needs_finance =
    /\b(how\s+much|total|sum|add\s+up|aggregate|breakdown|group|list|show|transactions?|charges?|spent|spend|by\s+(month|merchant|category)|top\s+\d+)\b/i.test(
      q
    ) ||
    /\b(invoice\s+revenue)\b/i.test(q);

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


