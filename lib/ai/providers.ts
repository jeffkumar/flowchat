import { gateway } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import {
  customProvider,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from "ai";
import { isTestEnvironment } from "../constants";

const openaiApiKey = process.env.OPENAI_API_KEY;
const useOpenAI = Boolean(openaiApiKey);
const openai = useOpenAI
  ? createOpenAI({
      apiKey: openaiApiKey,
    })
  : null;

export const myProvider = isTestEnvironment
  ? (() => {
      const {
        artifactModel,
        chatModel,
        reasoningModel,
        titleModel,
      } = require("./models.mock");
      return customProvider({
        languageModels: {
          "chat-model": chatModel,
          "chat-model-reasoning": reasoningModel,
          "title-model": titleModel,
          "artifact-model": artifactModel,
        },
      });
    })()
  : useOpenAI
    ? customProvider({
        languageModels: {
          // OpenAI direct (no Vercel AI Gateway required)
          "chat-model": openai!("gpt-5.1"),
          "chat-model-reasoning": openai!("gpt-5.1"),
          "title-model": openai!("gpt-5.1"),
          "artifact-model": openai!("gpt-5.1"),
        },
      })
    : customProvider({
        languageModels: {
          // Default to xAI via Vercel AI Gateway
          "chat-model": gateway.languageModel("xai/grok-2-vision-1212"),
          "chat-model-reasoning": wrapLanguageModel({
            model: gateway.languageModel("xai/grok-3-mini"),
            middleware: extractReasoningMiddleware({ tagName: "think" }),
          }),
          "title-model": gateway.languageModel("xai/grok-2-1212"),
          "artifact-model": gateway.languageModel("xai/grok-2-1212"),
        },
      });
