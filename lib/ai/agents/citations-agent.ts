import { generateText } from "ai";
import type { Session } from "next-auth";
import { z } from "zod";
import { myProvider } from "@/lib/ai/providers";
import {
  SpecialistAgentResponseSchema,
  type SpecialistAgentResponse,
} from "@/lib/ai/agents/types";

const CitationsAgentInputSchema = z.object({
  question: z.string().min(1).max(4000),
  draft_answer: z.string().min(1).max(20_000),
  sources: z
    .array(
      z.object({
        index: z.number().int().min(1),
        label: z.string().min(1).max(300),
        content: z.string().min(1).max(5000).optional(),
      })
    )
    .max(40),
});
export type CitationsAgentInput = z.infer<typeof CitationsAgentInputSchema>;

export async function runCitationsAgent({
  _session,
  input,
}: {
  _session: Session;
  input: CitationsAgentInput;
}): Promise<SpecialistAgentResponse> {
  const parsed = CitationsAgentInputSchema.parse(input);
  const model = myProvider.languageModel("chat-model-reasoning");

  const system = `You are CitationsAgent.\n\nYou MUST return ONLY valid JSON that matches this schema:\n${SpecialistAgentResponseSchema.toString()}\n\nRules:\n- Do not invent citations.\n- If the draft answer contains claims that are not supported by the provided sources, add a question_for_user or mark assumptions.\n- If supported, return a minimally edited answer_draft that includes inline citation markers like 【N】.\n- Only cite indices present in the sources list.\n`;

  const prompt = `User question:\n${parsed.question}\n\nDraft answer:\n${parsed.draft_answer}\n\nSources:\n${JSON.stringify(parsed.sources, null, 2)}\n\nReturn JSON only.`;

  const result = await generateText({
    model,
    system,
    prompt,
    maxRetries: 1,
  });

  const json = JSON.parse(result.text) as unknown;
  return SpecialistAgentResponseSchema.parse(json);
}


