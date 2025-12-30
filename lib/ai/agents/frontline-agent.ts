import { generateText } from "ai";
import type { Session } from "next-auth";
import { z } from "zod";
import { myProvider } from "@/lib/ai/providers";
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
  const model = myProvider.languageModel("chat-model-reasoning");
  const nowYear = new Date().getUTCFullYear();

  const system = `You are FrontlineAgent.\n\nYou MUST return ONLY valid JSON that matches this schema:\n${FrontlineDecisionSchema.toString()}\n\nRouting rules:\n- Use FinanceAgent if the user asks any totals/sums/counts or finance questions.\n- Use ProjectAgent if entity ambiguity is likely (personal vs business).\n- Use CitationsAgent when retrieved_context is present and the response should cite sources.\n- If a clarifying question is required, set questions_for_user and do not set direct_answer.\n- Keep direct_answer short when used.\n Now is ${nowYear}.`;

  const prompt = `User question:\n${parsed.question}\n\nRetrieved context (may be empty):\n${parsed.retrieved_context ?? ""}\n\nReturn JSON only.`;

  const result = await generateText({
    model,
    system,
    prompt,
    maxRetries: 1,
  });

  const json = JSON.parse(result.text) as unknown;
  return FrontlineDecisionSchema.parse(json);
}


