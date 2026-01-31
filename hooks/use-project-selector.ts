"use client";

import { useEffect } from "react";
import { useState } from "react";
import useSWR from "swr";
import { useLocalStorage } from "usehooks-ts";
import type { ProjectWithRole } from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";
import { fetcher } from "@/lib/utils";

export function useProjectSelector() {
  const storageKey = "flowchat-selected-project-id";

  const [selectedProjectId, setSelectedProjectId] = useLocalStorage<
    string | null
  >(storageKey, null, { initializeWithValue: false });

  const [hasCheckedStorage, setHasCheckedStorage] = useState(false);

  const { data, isLoading, mutate } = useSWR<{ projects: ProjectWithRole[] }>("/api/projects", fetcher, {
    onErrorRetry: (error, _key, _config, revalidate, opts) => {
      // If DB is unreachable locally, don't retry forever (it makes dev look "stuck").
      if (error instanceof ChatSDKError && error.type === "offline") return;
      if (opts.retryCount >= 3) return;
      setTimeout(() => revalidate({ retryCount: opts.retryCount + 1 }), 2000);
    },
  });

  const projects = data?.projects || [];

  // Ensure we read from localStorage once after mount before auto-selecting defaults.
  // `useLocalStorage(..., { initializeWithValue: false })` starts as `null`, which can
  // otherwise race with a fast `/api/projects` response and overwrite the user's selection.
  useEffect(() => {
    const storedRaw = window.localStorage.getItem(storageKey);
    if (storedRaw) {
      try {
        const parsed = JSON.parse(storedRaw) as unknown;
        if (typeof parsed === "string" && parsed.length > 0) {
          setSelectedProjectId(parsed);
        }
      } catch {
        // Ignore invalid storage contents; fallback selection logic will handle it.
      }
    }
    setHasCheckedStorage(true);
  }, [setSelectedProjectId, storageKey]);

  // Auto-select default project if nothing selected or selected ID invalid
  useEffect(() => {
    if (!hasCheckedStorage) return;
    if (isLoading || projects.length === 0) return;

    const currentExists = projects.find((p) => p.id === selectedProjectId);
    if (!selectedProjectId || !currentExists) {
      const defaultProject = projects.find((p) => p.isDefault);
      if (defaultProject) {
        setSelectedProjectId(defaultProject.id);
      } else if (projects.length > 0) {
        setSelectedProjectId(projects[0].id);
      }
    }
  }, [hasCheckedStorage, projects, isLoading, selectedProjectId, setSelectedProjectId]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  return {
    selectedProjectId,
    setSelectedProjectId,
    selectedProject,
    projects,
    isLoading,
    mutate,
  };
}
