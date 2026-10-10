"use client";

import ErrorState from "@/components/common/ErrorState";

/** Errore imprevisto in una pagina dell'area amministrazione: resta il guscio con la barra laterale. */
export default function AdminError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorState error={error} retry={retry} homeHref="/admin" />;
}
