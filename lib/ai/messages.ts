export const THINKING_MESSAGES = [
  "Synergy is going to work",
  "Putting on my thinking cap", 
  "Thinking if I should consult another agent", 
  "Formulating a response",
] as const;

export function getRandomThinkingMessage(): string {
  const randomIndex = Math.floor(Math.random() * THINKING_MESSAGES.length);
  return THINKING_MESSAGES[randomIndex];
}

