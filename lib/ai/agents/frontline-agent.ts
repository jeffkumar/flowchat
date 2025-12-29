import { generateText } from "ai";
import type { Session } from "next-auth";
import { z } from "zod";
import { myProvider } from "@/lib/ai/providers";
import { runFinanceAgent } from "@/lib/ai/agents/finance-agent";
import {
  FrontlineDecisionSchema,
  type FrontlineDecision,
} from "@/lib/ai/agents/types";

const FrontlineInputSchema = z.object({
  question: z.string().min(1).max(4000),
  chat_history: z.string().max(10_000).optional(),
  retrieved_context: z.string().max(50_000).optional(),
});
export type FrontlineInput = z.infer<typeof FrontlineInputSchema>;

const FINANCE_INTENT_RE =
  /\b(how\s+much|total|sum|spend|spent|spending|income|revenue|deposit|deposits|bring\s+in|made|paid|expense|expenses|charge|charges|waste|wasted|discretion|discretionary|discretional)\b/i;

export async function runFrontlineAgent({
  session,
  projectId,
  input,
}: {
  session: Session;
  projectId?: string;
  input: { question: string; chat_history?: string };
}): Promise<
  | { kind: "handled"; text: string }
  | { kind: "continue" }
> {
  const parsed = z
    .object({
      question: z.string().min(1).max(4000),
      chat_history: z.string().max(10_000).optional(),
    })
    .parse(input);

  // Finance-first: do not allow general chat model to answer finance questions.
  if (FINANCE_INTENT_RE.test(parsed.question)) {
    const q = parsed.question.toLowerCase();
    const entity_kind =
      q.includes("personal") ? ("personal" as const) : q.includes("business") ? ("business" as const) : undefined;
    const creditCardOnly = q.includes("credit card only") || q.includes("card only");
    const wantsCc = q.includes("credit card") || q.includes("card") || q.includes("amex") || q.includes("american express");
    const cardBrand = q.includes("amex") || q.includes("american express") ? ("amex" as const) : undefined;
    const docType =
      creditCardOnly || wantsCc ? ("cc_statement" as const) : undefined;

    const finance = await runFinanceAgent({
      session,
      projectId,
      input: {
        question: parsed.question,
        ...(typeof parsed.chat_history === "string" && parsed.chat_history.trim().length > 0
          ? { chat_history: parsed.chat_history }
          : {}),
        ...(entity_kind ? { entity_hint: { entity_kind } } : {}),
        preferences: {
          ...(docType ? { doc_type: docType } : {}),
          ...(cardBrand ? { card_brand: cardBrand } : {}),
          ...(creditCardOnly ? { credit_card_only: true } : {}),
        },
      },
    });

    const text =
      finance.questions_for_user.length > 0
        ? finance.questions_for_user.join(" ")
        : finance.answer_draft;

    return { kind: "handled", text };
  }

  return { kind: "continue" };
}

export async function decideFrontlineRouting({
  _session,
  input,
}: {
  _session: Session;
  input: FrontlineInput;
}): Promise<FrontlineDecision> {
  const parsed = FrontlineInputSchema.parse(input);
  const model = myProvider.languageModel("chat-model-reasoning");

  const system = `You are FrontlineAgent.\n\nYou MUST return ONLY valid JSON that matches this schema:\n${FrontlineDecisionSchema.toString()}\n\nRouting rules:\n- Use FinanceAgent if the user asks any totals/sums/counts or finance questions.\n- Use ProjectAgent if entity ambiguity is likely (personal vs business).\n- Use CitationsAgent when retrieved_context is present and the response should cite sources.\n- If a clarifying question is required, set questions_for_user and do not set direct_answer.\n- Keep direct_answer short when used.\n`;

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


