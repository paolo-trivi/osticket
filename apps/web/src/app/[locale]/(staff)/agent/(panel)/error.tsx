"use client";

import ErrorState from "@/components/common/ErrorState";

/** Errore imprevisto in una pagina del pannello agenti: resta il guscio con la barra laterale. */
export default function AgentError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorState error={error} retry={retry} homeHref="/agent" />;
}
