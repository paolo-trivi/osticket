/**
 * Parametri di connessione di un account email come osTicket\Mail\AccountSetting::__construct
 * (include/class.mail.php): schema ssl://, tls://, plain:// nell'host oppure porte standard
 * (465/993/995 → ssl, 587 → tls). La colonna email_account.encryption non viene usata dal PHP.
 */
export interface Connection {
  host: string;
  port: number;
  ssl: "ssl" | "tls" | null;
  protocol: string;
}

export function connectionOf(host: string | null, port: string | number | null, protocol: string | null): Connection {
  let h = String(host ?? "");
  const p = Math.trunc(Number(port ?? 0)) || 0;
  let ssl: Connection["ssl"] = null;
  const m = /^(ssl|tls|plain):\/\/(.*)$/su.exec(h.toLowerCase());
  if (m) {
    ssl = m[1] === "plain" ? null : (m[1] as "ssl" | "tls");
    h = m[2];
  } else if (p) {
    if ([465, 993, 995].includes(p)) ssl = "ssl";
    else if (p === 587) ssl = "tls";
  }
  return { host: h, port: p, ssl, protocol: String(protocol ?? "").toUpperCase() };
}
