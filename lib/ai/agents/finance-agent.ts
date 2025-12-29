import { generateText } from "ai";
import type { Session } from "next-auth";
import { z } from "zod";
import { myProvider } from "@/lib/ai/providers";
import { financeQuery } from "@/lib/ai/tools/finance-query";
import {
  SpecialistAgentResponseSchema,
  type SpecialistAgentResponse,
} from "@/lib/ai/agents/types";

const FinanceAgentInputSchema = z.object({
  question: z.string().min(1).max(4000),
  // Optional hints the frontline can pass
  projectId: z.string().uuid().optional(),
  entity_hint: z
    .object({
      entity_kind: z.enum(["personal", "business"]).optional(),
      entity_name: z.string().min(1).max(200).optional(),
    })
    .optional(),
  time_hint: z
    .object({
      kind: z.enum(["year", "month"]).optional(),
      year: z.number().int().min(1900).max(2200).optional(),
      month: z.number().int().min(1).max(12).optional(),
    })
    .optional(),
});
export type FinanceAgentInput = z.infer<typeof FinanceAgentInputSchema>;

export async function runFinanceAgent({
  session,
  projectId,
  input,
}: {
  session: Session;
  projectId?: string;
  input: FinanceAgentInput;
}): Promise<SpecialistAgentResponse> {
  const parsed = FinanceAgentInputSchema.parse({ ...input, projectId: projectId ?? input.projectId });

  const model = myProvider.languageModel("chat-model-reasoning");

  const system = `You are FinanceAgent.\n\nYou MUST return ONLY valid JSON that matches this schema:\n${SpecialistAgentResponseSchema.toString()}\n\nRules:\n- Use financeQuery for any totals/sums/aggregations. Never compute math yourself.\n- Prefer bank_statement deposits for income-like questions (made/brought in/income/deposits/revenue), with filters.amount_min > 0 and filters.exclude_categories=['transfer'].\n- If the user explicitly asks about invoice revenue, use document_type='invoice'.\n- If the user did not specify personal vs a specific business entity, ask a clarifying question in questions_for_user and do NOT run financeQuery.\n- If bank_statement deposits return 0 rows and the user did not explicitly ask invoice revenue, set fallback_to_invoice_if_empty=true.\n- Keep answer_draft concise; frontline will present final answer.\n`;

  const prompt = `User question:\n${parsed.question}\n\nHints:\n${JSON.stringify({ entity_hint: parsed.entity_hint ?? null, time_hint: parsed.time_hint ?? null }, null, 2)}\n\nReturn JSON only.`;

  const result = await generateText({
    model,
    system,
    prompt,
    maxRetries: 1,
    tools: {
      financeQuery: financeQuery({ session, projectId: parsed.projectId }),
    },
  });

  const json = JSON.parse(result.text) as unknown;
  return SpecialistAgentResponseSchema.parse(json);
}


