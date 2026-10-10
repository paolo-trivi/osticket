"use client";

import en from "@/messages/en.json";
import it from "@/messages/it.json";

/**
 * Errore nel layout principale ([locale]/layout.tsx): sostituisce l'intero documento, senza provider di
 * lingua né fogli di stile della app. Pagina minima con i testi (src/messages) in entrambe le lingue.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="it">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "4rem 1rem", textAlign: "center" }}>
        <title>{it.common.appName}</title>
        <h1 style={{ fontSize: "1.25rem" }}>{it.errorPage.title}</h1>
        <p lang="en">{en.errorPage.title}</p>
        {error.digest && <p style={{ fontFamily: "monospace", fontSize: "0.75rem" }}>{error.digest}</p>}
        <button type="button" onClick={() => retry()} style={{ marginTop: "1rem", padding: "0.5rem 1rem" }}>
          {it.errorPage.retry} · <span lang="en">{en.errorPage.retry}</span>
        </button>
      </body>
    </html>
  );
}
