"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { useWriteMode } from "@/context/WriteModeContext";
import type { WriteScope } from "@/lib/write-mode";

import Callout from "./Callout";

/** Mostra `children` solo se l'ambito è scrivibile, altrimenti `fallback` (nulla per default). */
export function WriteGate({ scope = "operational", fallback = null, children }: { scope?: WriteScope; fallback?: ReactNode; children: ReactNode }) {
  return useWriteMode().canWrite(scope) ? children : fallback;
}

/**
 * Testo per i controlli disattivati dalla sola lettura (title/tooltip): undefined se si può scrivere,
 * così in modalità completa i pulsanti restano invariati.
 */
export function useReadOnlyHint(scope: WriteScope = "operational"): string | undefined {
  const t = useTranslations("writeMode");
  const { mode, canWrite } = useWriteMode();
  if (canWrite(scope)) return undefined;
  return scope === "admin" && mode === "operational" ? t("hintAdmin") : t("hint");
}

/** Avviso al posto di un form non disponibile in sola lettura (testo per i clienti con `portal`). */
export function ReadOnlyNotice({ scope = "operational", portal = false }: { scope?: WriteScope; portal?: boolean }) {
  const t = useTranslations("writeMode");
  const { mode } = useWriteMode();
  const text = portal ? t("noticePortal") : scope === "admin" && mode === "operational" ? t("noticeAdmin") : t("notice");
  return (
    <Callout tone="info" role="status">
      {text}
    </Callout>
  );
}

/** Avviso di sola lettura mostrato solo quando l'ambito non è scrivibile (es. in testa a un form). */
export function ReadOnlyNote({ scope = "operational", portal = false }: { scope?: WriteScope; portal?: boolean }) {
  return useWriteMode().canWrite(scope) ? null : <ReadOnlyNotice scope={scope} portal={portal} />;
}
