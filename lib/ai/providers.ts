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

const basetenApiKey = process.env.BASETEN_API_KEY;
const baseten = basetenApiKey
  ? createOpenAI({
      apiKey: basetenApiKey,
      baseURL: "https://inference.baseten.co/v1",
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
          "deepseek-v3": chatModel,
        },
      });
    })()
  : customProvider({
      languageModels: {
        "chat-model": useOpenAI
          ? openai!("gpt-5.1")
          : baseten
            ? baseten.chat("deepseek-ai/DeepSeek-V3.2")
            : gateway.languageModel("xai/grok-2-vision-1212"),
        "chat-model-reasoning": useOpenAI
          ? openai!("gpt-5.1")
          : baseten
            ? baseten.chat("deepseek-ai/DeepSeek-V3.2")
            : wrapLanguageModel({
                model: gateway.languageModel("xai/grok-3-mini"),
                middleware: extractReasoningMiddleware({ tagName: "think" }),
              }),
        "title-model": useOpenAI
          ? openai!("gpt-5.1")
          : baseten
            ? baseten.chat("deepseek-ai/DeepSeek-V3.2")
            : gateway.languageModel("xai/grok-2-1212"),
        "artifact-model": useOpenAI
          ? openai!("gpt-5.1")
          : baseten
            ? baseten.chat("deepseek-ai/DeepSeek-V3.2")
            : gateway.languageModel("xai/grok-2-1212"),
        ...(baseten
          ? {
              "deepseek-v3": baseten.chat("deepseek-ai/DeepSeek-V3.2"),
            }
          : {}),
      },
    });
