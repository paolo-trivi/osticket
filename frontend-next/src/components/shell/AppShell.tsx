"use client";

import { useSidebar } from "@/context/SidebarContext";
import AppHeader from "@/layout/AppHeader";
import AppSidebar from "@/layout/AppSidebar";
import Backdrop from "@/layout/Backdrop";
import type { NavSection, ShellUser } from "@/layout/nav-types";
import { cn } from "@/utils";
import type { ReactNode } from "react";

interface Props {
  sections: NavSection[];
  homeHref: string;
  user: ShellUser;
  searchHref?: string;
  logoutAction: () => Promise<void>;
  menuLinks?: { label: string; href: string; external?: boolean }[];
  children: ReactNode;
}

/** Guscio TailAdmin (sidebar + header) condiviso da pannello agenti e area admin. */
export default function AppShell({ sections, homeHref, user, searchHref, logoutAction, menuLinks, children }: Props) {
  const { isExpanded, isHovered, isMobileOpen } = useSidebar();
  const margin = isMobileOpen ? "ms-0" : isExpanded || isHovered ? "xl:ms-72.5" : "xl:ms-22.5";

  return (
    <div className="min-h-screen xl:flex">
      <AppSidebar sections={sections} homeHref={homeHref} />
      <Backdrop />
      <div className={cn("flex-1 transition-all duration-300 ease-in-out", margin)}>
        <AppHeader user={user} searchHref={searchHref} logoutAction={logoutAction} menuLinks={menuLinks} />
        <div className="mx-auto max-w-(--breakpoint-2xl) p-4 md:p-6">{children}</div>
      </div>
    </div>
  );
}
