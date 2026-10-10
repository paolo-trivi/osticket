/**
 * Percorso interno sicuro per i redirect dopo il login (parametro `next` dall'URL): niente open redirect.
 * Ammessi solo percorsi relativi che iniziano con un solo "/" (non "//" né "/\"), senza backslash
 * (anche codificati) né caratteri di controllo; il percorso si normalizza con il parser URL del browser
 * (che tratta "\" come "/" e risolve "..") e deve restare sulla stessa origine e non iniziare con "//".
 * `allow` filtra il percorso normalizzato (es. solo /agent per gli agenti). Altrimenti `fallback`.
 */
const BASE = "http://next.invalid";

export function safeRedirectPath(next: unknown, fallback: string, allow: (pathname: string) => boolean = () => true): string {
  if (typeof next !== "string" || !next) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(next) || /%5c/i.test(next)) return fallback;
  if (!next.startsWith("/") || next.startsWith("//")) return fallback;
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE || url.pathname.startsWith("//")) return fallback;
  if (!allow(url.pathname)) return fallback;
  return url.pathname + url.search + url.hash;
}

/** Percorsi del pannello agenti (/agent e sotto-percorsi). */
export function isAgentPath(pathname: string): boolean {
  return pathname === "/agent" || pathname.startsWith("/agent/");
}

/** Percorsi del portale clienti: tutto tranne pannello agenti e amministrazione. */
export function isPortalPath(pathname: string): boolean {
  return !/^\/(agent|admin)(\/|$)/.test(pathname);
}
