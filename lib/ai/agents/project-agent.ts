import { generateText } from "ai";
import type { Session } from "next-auth";
import { z } from "zod";
import { myProvider } from "@/lib/ai/providers";
import { getProjectEntitySummaryForUser } from "@/lib/db/queries";
import {
  SpecialistAgentResponseSchema,
  type SpecialistAgentResponse,
} from "@/lib/ai/agents/types";

const ProjectAgentInputSchema = z.object({
  question: z.string().min(1).max(4000),
  projectId: z.string().uuid(),
});
export type ProjectAgentInput = z.infer<typeof ProjectAgentInputSchema>;

export async function runProjectAgent({
  session,
  input,
}: {
  session: Session;
  input: ProjectAgentInput;
}): Promise<SpecialistAgentResponse> {
  if (!session.user?.id) {
    return SpecialistAgentResponseSchema.parse({
      kind: "project",
      answer_draft: "",
      questions_for_user: ["Please sign in again."],
      assumptions: [],
      tool_calls: [],
      citations: [],
      confidence: "low",
    });
  }

  const parsed = ProjectAgentInputSchema.parse(input);
  const entitySummary = await getProjectEntitySummaryForUser({
    userId: session.user.id,
    projectId: parsed.projectId,
  });

  const model = myProvider.languageModel("chat-model-reasoning");
  const system = `You are ProjectAgent.\n\nYou MUST return ONLY valid JSON that matches this schema:\n${SpecialistAgentResponseSchema.toString()}\n\nRules:\n- Summarize project entity state.\n- If multiple entities exist and the user asks an income-like question, suggest a clarifying question.\n- Keep answer_draft short and structured.\n`;

  const prompt = `User question:\n${parsed.question}\n\nProject entity summary rows:\n${JSON.stringify(entitySummary, null, 2)}\n\nReturn JSON only.`;

  const result = await generateText({
    model,
    system,
    prompt,
    maxRetries: 1,
  });

  const json = JSON.parse(result.text) as unknown;
  return SpecialistAgentResponseSchema.parse(json);
}


