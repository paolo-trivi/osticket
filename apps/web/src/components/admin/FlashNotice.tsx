"use client";

import { useEffect, useState, type ReactNode } from "react";

import Callout from "@/components/common/Callout";

/** Parametri d'esito passati in query string dalle server action (redirect con ?ok=…, ?created=1…). */
const FLASH_PARAMS = ["ok", "n", "err", "created", "entry_added", "cs"];

/**
 * Esito di un'azione letto dall'URL: mostrato una volta sola. Al montaggio toglie i parametri
 * d'esito dall'URL (ricaricando o salvando di nuovo non ricompare) e si nasconde al primo submit di
 * un form della pagina, così resta visibile solo l'esito dell'operazione corrente. La `key` data dal
 * server a ogni render lo rimonta quando arriva un nuovo esito.
 */
export default function FlashNotice({ tone, children }: { tone: "success" | "error"; children: ReactNode }) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    const found = FLASH_PARAMS.filter((k) => url.searchParams.has(k));
    if (found.length) {
      for (const k of found) url.searchParams.delete(k);
      // integrato con il router di Next (history.replaceState): nessun nuovo render del server
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    const onSubmit = () => setHidden(true);
    document.addEventListener("submit", onSubmit, true);
    return () => document.removeEventListener("submit", onSubmit, true);
  }, []);
  if (hidden) return null;
  return (
    <Callout tone={tone} role={tone === "error" ? "alert" : "status"}>
      {children}
    </Callout>
  );
}
