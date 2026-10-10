import { createHash } from "node:crypto";

import { decrypt } from "../../crypto/crypto";
import { decodeMessageId } from "../../mail/message-id";

/**
 * Verifica di SECRET_SALT con fonti indipendenti presenti nel DB, senza mai esporre il salt.
 *
 * 1. Message-ID di osTicket: Mailer::getMessageId (include/class.mailer.php) produce
 *    B<sysid>-<rand>-<tag>-<email di sistema>, dove sysid = base64(md5('mail'.SECRET_SALT))[0..6] e il
 *    tag è firmato con HMAC-SHA1 sul salt. Il PHP non registra i Message-ID in uscita, ma le risposte dei
 *    destinatari li riportano in In-Reply-To/References: il fetcher li salva in thread_entry_email.headers
 *    (ThreadEntry::logEmailHeaders). Si considerano solo quelli firmati con un'email di sistema
 *    dell'installazione (gli altri possono venire da altri osTicket).
 * 2. Credenziali cifrate degli account email (config `email.<id>.account.<id>`: passwd con sottochiave
 *    md5(username . namespace), access/refresh_token OAuth2 con md5(resource_owner_email . namespace)),
 *    come EmailAccount::getBasicAuthCredentials / getOAuth2AuthCredentials (include/class.email.php).
 *    Con AES-CBC una chiave sbagliata fallisce quasi sempre la verifica del padding.
 *
 * Nota: anche TailTicket genera Message-ID e cifra credenziali con il salt configurato; le fonti sono
 * indipendenti solo per le righe prodotte dal PHP. Per questo basta una discordanza per bloccare.
 */

/** Message-ID di osTicket (versione B) dentro un testo di header. */
const MID_RE = /B[A-Za-z0-9/=]{6}-[A-Za-z0-9_=]{5}-[A-Za-z0-9+/]{24}-[^\s<>,;"()]+/g;

export function extractOsTicketMessageIds(text: string): string[] {
  return [...new Set(text.match(MID_RE) ?? [])];
}

/** Email di sistema che firma il Message-ID (ultima parte dopo il tag). */
function midSignature(mid: string): string {
  return mid.split("-").slice(3).join("-").toLowerCase();
}

interface SourceTally {
  match: number;
  mismatch: number;
}

/** Confronta i Message-ID trovati con il salt configurato, solo per quelli firmati dalle email di sistema. */
export function tallyMessageIds(mids: readonly string[], secretSalt: string, systemAddresses: readonly string[]): SourceTally {
  const own = new Set(systemAddresses.map((a) => a.toLowerCase()));
  const tally: SourceTally = { match: 0, mismatch: 0 };
  for (const mid of new Set(mids)) {
    if (!own.has(midSignature(mid))) continue;
    if (decodeMessageId(mid, secretSalt).loopback) tally.match++;
    else tally.mismatch++;
  }
  return tally;
}

/** Valori cifrati di un namespace `email.<id>.account.<id>` della tabella config. */
export interface StoredCredential {
  namespace: string;
  values: Readonly<Record<string, string>>;
}

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
/** Formati di Crypto gestiti (2 = OpenSSL, 3 = phpseclib); gli altri si ignorano. */
const SUPPORTED_CIPHERTEXT = /^\$[23]\$./;

export function tallyCredentials(creds: readonly StoredCredential[], secretSalt: string): SourceTally {
  const tally: SourceTally = { match: 0, mismatch: 0 };
  const probe = (value: string | undefined, subOwner: string | undefined, ns: string) => {
    if (!value || !SUPPORTED_CIPHERTEXT.test(value) || subOwner === undefined) return;
    if (decrypt(value, secretSalt, md5(subOwner + ns)) === false) tally.mismatch++;
    else tally.match++;
  };
  for (const { namespace: ns, values: v } of creds) {
    probe(v.passwd, v.username, ns);
    probe(v.access_token, v.resource_owner_email, ns);
    probe(v.refresh_token, v.resource_owner_email, ns);
  }
  return tally;
}

type SaltVerdict = "ok" | "mismatch" | "unverifiable";

/** Esito complessivo: nessuna fonte = non verificabile; anche una sola discordanza = incoerente. */
export function saltVerdict(...sources: SourceTally[]): SaltVerdict {
  const match = sources.reduce((n, s) => n + s.match, 0);
  const mismatch = sources.reduce((n, s) => n + s.mismatch, 0);
  if (mismatch > 0) return "mismatch";
  return match > 0 ? "ok" : "unverifiable";
}
