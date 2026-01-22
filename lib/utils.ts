import type {
  CoreAssistantMessage,
  CoreToolMessage,
  UIMessage,
  UIMessagePart,
} from 'ai';
import { type ClassValue, clsx } from 'clsx';
import { formatISO } from 'date-fns';
import { twMerge } from 'tailwind-merge';
import type { DBMessage, Document } from '@/lib/db/schema';
import { ChatSDKError, type ErrorCode } from './errors';
import type { ChatMessage, ChatTools, CustomUIDataTypes } from './types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const fetcher = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) {
    const cloned = response.clone();
    try {
      const { code, cause } = (await response.json()) as {
        code: string;
        cause?: string;
      };
      throw new ChatSDKError(code as ErrorCode, cause);
    } catch {
      const bodyText = await cloned.text().catch(() => "");
      throw new ChatSDKError("bad_request:api", bodyText);
    }
  }

  return response.json();
};

export async function fetchWithErrorHandlers(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  try {
    const response = await fetch(input, init);

    if (!response.ok) {
      const cloned = response.clone();
      try {
        const { code, cause } = (await response.json()) as {
          code: string;
          cause?: string;
        };
        throw new ChatSDKError(code as ErrorCode, cause);
      } catch {
        const bodyText = await cloned.text().catch(() => "");
        throw new ChatSDKError("bad_request:api", bodyText);
      }
    }

    return response;
  } catch (error: unknown) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new ChatSDKError('offline:chat');
    }

    throw error;
  }
}

export function getLocalStorage(key: string) {
  if (typeof window !== 'undefined') {
    try {
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      // If parsing fails (e.g. legacy plain string), return the raw string or empty array fallback
      const raw = localStorage.getItem(key);
      return raw ?? [];
    }
  }
  return [];
}

const IGNORED_DOC_IDS_PREFIX = 'flowchat:ignoredDocIds:';

export function getIgnoredDocIdsStorageKey(projectId: string) {
  return `${IGNORED_DOC_IDS_PREFIX}${projectId}`;
}

export function readIgnoredDocIdsForProject(projectId: string): string[] {
  if (typeof window === 'undefined') return [];

  const raw = localStorage.getItem(getIgnoredDocIdsStorageKey(projectId));
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

export function writeIgnoredDocIdsForProject(projectId: string, ids: string[]) {
  if (typeof window === 'undefined') return;
  const unique = Array.from(new Set(ids.filter((v) => typeof v === 'string' && v.length > 0)));
  localStorage.setItem(getIgnoredDocIdsStorageKey(projectId), JSON.stringify(unique));
}

export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

type ResponseMessageWithoutId = CoreToolMessage | CoreAssistantMessage;
type ResponseMessage = ResponseMessageWithoutId & { id: string };

export function getMostRecentUserMessage(messages: UIMessage[]) {
  const userMessages = messages.filter((message) => message.role === 'user');
  return userMessages.at(-1);
}

export function getDocumentTimestampByIndex(
  documents: Document[],
  index: number,
) {
  if (!documents) { return new Date(); }
  if (index > documents.length) { return new Date(); }

  return documents[index].createdAt;
}

export function getTrailingMessageId({
  messages,
}: {
  messages: ResponseMessage[];
}): string | null {
  const trailingMessage = messages.at(-1);

  if (!trailingMessage) { return null; }

  return trailingMessage.id;
}

export function sanitizeText(text: string) {
  return text.replace('<has_function_call>', '');
}

export function convertToUIMessages(messages: DBMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role as 'user' | 'assistant' | 'system',
    parts: message.parts as UIMessagePart<CustomUIDataTypes, ChatTools>[],
    metadata: {
      createdAt: formatISO(message.createdAt),
    },
  }));
}

export function getTextFromMessage(message: ChatMessage | UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part as { type: 'text'; text: string}).text)
    .join('');
}
