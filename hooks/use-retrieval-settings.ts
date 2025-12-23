"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { RetrievalRangePreset } from "@/components/chat-header";

const INCLUDE_SLACK_STORAGE_KEY = "synergy_retrieval_include_slack";
const SOURCE_TYPES_STORAGE_KEY = "synergy_retrieval_source_types";
const RANGE_PRESET_STORAGE_KEY = "synergy_retrieval_range_preset";
const SETTINGS_CHANGED_EVENT = "synergy:retrieval-settings-changed";

function readJson<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(
      new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: { key } })
    );
  } catch {
    // ignore
  }
}

function sanitizeIncludeSlack(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function sanitizeRangePreset(value: unknown): RetrievalRangePreset | null {
  return value === "all" ||
    value === "1d" ||
    value === "7d" ||
    value === "30d" ||
    value === "90d"
    ? value
    : null;
}

function includeSlackFromLegacySourceTypes(value: unknown): boolean | null {
  if (!Array.isArray(value)) return null;
  for (const v of value) {
    if (v === "slack") return true;
  }
  return false;
}

function readIncludeSlackFromStorage(): boolean | null {
  const savedIncludeSlack = sanitizeIncludeSlack(readJson(INCLUDE_SLACK_STORAGE_KEY));
  if (savedIncludeSlack !== null) return savedIncludeSlack;
  const legacyIncludeSlack = includeSlackFromLegacySourceTypes(
    readJson(SOURCE_TYPES_STORAGE_KEY)
  );
  return legacyIncludeSlack;
}

function readRangePresetFromStorage(): RetrievalRangePreset | null {
  return sanitizeRangePreset(readJson(RANGE_PRESET_STORAGE_KEY));
}

export function useRetrievalSettings() {
  const subscribe = useCallback((onStoreChange: () => void) => {
    if (typeof window === "undefined") return () => {};

    const onSettingsChanged = (event: Event) => {
      const custom = event as CustomEvent<{ key?: unknown }>;
      const key = typeof custom.detail?.key === "string" ? custom.detail.key : null;
      if (
        key === null ||
        key === INCLUDE_SLACK_STORAGE_KEY ||
        key === RANGE_PRESET_STORAGE_KEY ||
        key === SOURCE_TYPES_STORAGE_KEY
      ) {
        onStoreChange();
      }
    };

    const onStorage = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === INCLUDE_SLACK_STORAGE_KEY ||
        event.key === RANGE_PRESET_STORAGE_KEY ||
        event.key === SOURCE_TYPES_STORAGE_KEY
      ) {
        onStoreChange();
      }
    };

    window.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const includeSlack = useSyncExternalStore<boolean>(
    subscribe,
    () => readIncludeSlackFromStorage() ?? true,
    () => true
  );

  const retrievalRangePreset = useSyncExternalStore<RetrievalRangePreset>(
    subscribe,
    () => readRangePresetFromStorage() ?? "all",
    () => "all"
  );

  const setIncludeSlack = useCallback((next: boolean) => {
    writeJson(INCLUDE_SLACK_STORAGE_KEY, next);
  }, []);

  const setRetrievalRangePreset = useCallback((next: RetrievalRangePreset) => {
    writeJson(RANGE_PRESET_STORAGE_KEY, next);
  }, []);

  return {
    includeSlack,
    setIncludeSlack,
    retrievalRangePreset,
    setRetrievalRangePreset,
  };
}


