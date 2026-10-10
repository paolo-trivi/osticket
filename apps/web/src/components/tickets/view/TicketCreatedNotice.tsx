"use client";

import { useEffect } from "react";

import ActionNotice from "@/components/common/ActionNotice";

import { useTicketNotice } from "./use-ticket-notice";

/**
 * "Ticket creato" dopo l'apertura da agente (?created=1, il messaggio di scp/tickets.php a=open). Il
 * parametro esce subito dall'URL, così un ricaricamento non ripete l'avviso; un esito successivo lo sostituisce.
 */
export default function TicketCreatedNotice({ text, closeLabel }: { text: string; closeLabel: string }) {
  const [notice, setNotice] = useTicketNotice<string>(text);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("created")) return;
    url.searchParams.delete("created");
    window.history.replaceState(window.history.state, "", url);
  }, []);
  if (!notice) return null;
  return (
    <ActionNotice closeLabel={closeLabel} onClose={() => setNotice(null)}>
      {notice}
    </ActionNotice>
  );
}
