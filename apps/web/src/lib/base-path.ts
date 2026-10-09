/**
 * Prefisso del sotto-percorso in cui è pubblicata la app (NEXT_BASE_PATH, es. "/app" dietro reverse proxy).
 * Va applicato agli URL assoluti scritti a mano (<img>, next/image, href verso /api/...): i <Link> di
 * next-intl e i redirect lo aggiungono già da soli.
 */
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function withBase(path: string): string {
  return path.startsWith("/") ? `${BASE_PATH}${path}` : path;
}
