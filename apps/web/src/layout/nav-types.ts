import type { ReactNode } from "react";

export interface NavChild {
  label: string;
  href: string;
  exact?: boolean;
  badge?: number | string;
  /** altri link che attivano la voce (es. le sotto-code di una coda) */
  alias?: string[];
  /**
   * voce predefinita del percorso del link: attiva quando la pagina non ha nessuno di questi parametri
   * (es. la coda predefinita su /agent/tickets senza ?queue, ?q, ?user, ?org)
   */
  fallbackUnless?: string[];
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
  /** percorso dell'area del gruppo: vi appartengono anche le pagine senza voce (es. /agent/tickets/12) */
  area?: string;
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
