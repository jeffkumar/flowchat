export const DEFAULT_CHAT_MODEL: string = "chat-model";

export type ChatModel = {
  id: string;
  name: string;
  description: string;
};

export const chatModels: ChatModel[] = [
  {
    id: "chat-model",
    name: "Grok Vision",
    description: "Advanced multimodal model with vision and text capabilities",
  },
  {
    id: "chat-model-reasoning",
    name: "Grok Reasoning",
    description:
      "Uses advanced chain-of-thought reasoning for complex problems",
  },
  {
    id: "deepseek-v3",
    name: "DeepSeek V3",
    description: "High-performance model from Baseten",
  },
];

// Agent Modes
export type AgentMode = "project" | "finance";

export type AgentModeConfig = {
  id: AgentMode;
  name: string;
  description: string;
};

export const agentModes: AgentModeConfig[] = [
  {
    id: "project",
    name: "Project",
    description: "Document Q&A, chat, and artifacts",
  },
  {
    id: "finance",
    name: "Finance",
    description: "Financial analysis and transactions",
  },
];

export const DEFAULT_AGENT_MODE: AgentMode = "project";
