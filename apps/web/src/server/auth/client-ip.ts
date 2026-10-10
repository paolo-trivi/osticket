/**
 * IP del client dietro il reverse proxy (unica fonte: blocco dei tentativi, binding IP della sessione,
 * syslog, thread_entry.ip_address). Il PHP usa REMOTE_ADDR; la app Next è sempre dietro un proxy, quindi
 * si fida solo degli header che il proxy imposta:
 *  1. `X-Real-IP`: il proxy lo sovrascrive con l'indirizzo del client (Caddy `header_up X-Real-IP
 *     {client_ip}`, nginx `proxy_set_header X-Real-IP $remote_addr`);
 *  2. se manca, `X-Forwarded-For` letto da destra: ogni proxy fidato aggiunge in coda l'indirizzo da cui
 *     riceve la richiesta, quindi con N proxy fidati l'IP del client è l'N-esimo valore da destra. I valori
 *     più a sinistra li sceglie il client e non contano.
 * N è TAILTICKET_TRUSTED_PROXY_HOPS (default 1, il solo proxy del deploy di riferimento); con 0 gli
 * header non sono attendibili e l'IP è sconosciuto ("0.0.0.0").
 */

const UNKNOWN_IP = "0.0.0.0";

interface HeaderSource {
  get(name: string): string | null;
}

/** Numero di proxy fidati davanti alla app (TAILTICKET_TRUSTED_PROXY_HOPS, intero >= 0, default 1). */
export function trustedProxyHops(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TAILTICKET_TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 1;
  return /^\d+$/.test(raw) ? Number(raw) : 1;
}

/** Indirizzo IPv4/IPv6 plausibile (senza porta né spazi): scarta valori arbitrari scritti nei log. */
function plausibleIp(v: string): boolean {
  return v.length > 0 && v.length <= 45 && /^[0-9A-Fa-f:.]+$/.test(v) && /[.:]/.test(v);
}

export function resolveClientIp(headers: HeaderSource, hops = trustedProxyHops()): string {
  if (hops < 1) return UNKNOWN_IP;
  const real = headers.get("x-real-ip")?.trim();
  if (real) return plausibleIp(real) ? real : UNKNOWN_IP;
  const chain = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!chain.length) return UNKNOWN_IP;
  // meno valori dei proxy dichiarati: il più a sinistra è comunque stato aggiunto da un proxy fidato
  const ip = chain[Math.max(0, chain.length - hops)];
  return plausibleIp(ip) ? ip : UNKNOWN_IP;
}
