import type { ReactNode } from "react";

export interface NavChild {
  label: string;
  href: string;
  exact?: boolean;
  badge?: number | string;
}

export interface NavItem {
  key: string;
  label: string;
  icon: ReactNode;
  href?: string;
  exact?: boolean;
  /** link verso un'altra applicazione (es. pannello osTicket classico) */
  external?: boolean;
  children?: NavChild[];
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export interface ShellUser {
  name: string;
  email: string;
  subtitle?: string;
  initials: string;
}
