"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

/** Dati del tema configurato in admin che servono ai componenti client (logo, nome, sidebar). */
export interface Branding {
  displayName: string;
  sidebarStyle: "light" | "dark" | "brand";
  /** loghi caricati in osTicket (Admin > Impostazioni): serviti da /api/branding/<tipo> */
  hasStaffLogo: boolean;
  hasClientLogo: boolean;
  hasBackdrop: boolean;
  loginTagline: string;
}

interface BrandingState extends Branding {
  /** anteprima dall'editor del tema (non salvata) */
  preview: (partial: Partial<Branding> | null) => void;
}

const DEFAULT: Branding = {
  displayName: "TailTicket",
  sidebarStyle: "light",
  hasStaffLogo: false,
  hasClientLogo: false,
  hasBackdrop: false,
  loginTagline: "",
};

const BrandingContext = createContext<BrandingState>({ ...DEFAULT, preview: () => {} });

export function BrandingProvider({ value, children }: { value: Branding; children: ReactNode }) {
  const [override, setOverride] = useState<Partial<Branding> | null>(null);
  return (
    <BrandingContext.Provider value={{ ...value, ...override, preview: setOverride }}>{children}</BrandingContext.Provider>
  );
}

export function useBranding(): BrandingState {
  return useContext(BrandingContext);
}
