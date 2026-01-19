export const THINKING_MESSAGES = [
  "Flowchat is going to work",
  "Putting on my thinking cap", 
  "Thinking if I should consult another agent for help",  
] as const;

export function getRandomThinkingMessage(): string {
  const randomIndex = Math.floor(Math.random() * THINKING_MESSAGES.length);
  return THINKING_MESSAGES[randomIndex];
}

