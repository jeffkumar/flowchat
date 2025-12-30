export const THINKING_MESSAGES = [
  "Synergy is going to work",
  "Putting on my thinking cap",
  "don't be upset if i make mistakes i'm learning",
  "Searching for the right answer",
  "Connecting the dots",
  "Consulting the archives",
  "Crunching the numbers",
  "Analyzing the situation",
  "Synthesizing information",
  "Formulating a response",
] as const;

export function getRandomThinkingMessage(): string {
  const randomIndex = Math.floor(Math.random() * THINKING_MESSAGES.length);
  return THINKING_MESSAGES[randomIndex];
}

