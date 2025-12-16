"use client";

import { useEffect } from "react";
import useSWR from "swr";
import { useLocalStorage } from "usehooks-ts";
import type { Project } from "@/lib/db/schema";
import { fetcher } from "@/lib/utils";

export function useProjectSelector() {
  const [selectedProjectId, setSelectedProjectId] = useLocalStorage<
    string | null
  >("flowchat-selected-project-id", null);

  const { data, isLoading, mutate } = useSWR<{ projects: Project[] }>(
    "/api/projects",
    fetcher
  );

  const projects = data?.projects || [];

  // Auto-select default project if nothing selected or selected ID invalid
  useEffect(() => {
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
  }, [projects, isLoading, selectedProjectId, setSelectedProjectId]);

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
