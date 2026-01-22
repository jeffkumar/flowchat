"use client";

import { SidebarToggle } from "@/components/sidebar-toggle";
import { ProjectSwitcher } from "@/components/project-switcher";

export function ProjectFilesHeader() {
  return (
    <header className="sticky top-0 z-10 flex items-center gap-2 bg-background px-2 py-1.5 md:px-2">
      <SidebarToggle />
      <ProjectSwitcher />
    </header>
  );
}

