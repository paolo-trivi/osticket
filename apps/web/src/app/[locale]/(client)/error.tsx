"use client";

import ErrorState from "@/components/common/ErrorState";

/** Errore imprevisto in una pagina del portale clienti: restano testata e piè di pagina del portale. */
export default function PortalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorState error={error} retry={retry} homeHref="/" />;
}
