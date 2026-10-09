import "server-only";

import { randomBytes, randomInt } from "node:crypto";

import type { ConfigNamespace } from "../config/config";
import type { DbOrTx } from "../db";
import { phpJsonDecode } from "../format/php-json";
import { loadStaffInfo, staffVar } from "../mail/objects";
import { alertOrDefaultEmail, loadContentPage, sendContentMail } from "../domain/directory/content-mail";

/**
 * Secondo fattore via email per gli agenti (include/class.2fa.php, Email2FABackend "2fa-email").
 *
 * Il PHP conserva codice, ora e tentativi in $_SESSION['_2fa'][id]; qui lo stato vive in memoria del
 * processo, indicizzato da una chiave casuale salvata nel cookie di sessione (mai il codice): stessa
 * scadenza (6 minuti) e stesso limite di tentativi (3). Un riavvio del server annulla i codici pendenti.
 */
export const EMAIL_2FA = "2fa-email";
const TIMEOUT_MIN = 6;
const MAX_STRIKES = 3;

interface OtpState {
  staffId: number;
  otp: string;
  time: number;
  strikes: number;
}

const store = new Map<string, OtpState>();

function sweep(): void {
  const limit = Date.now() / 1000 - TIMEOUT_MIN * 60 * 2;
  for (const [k, v] of store) if (v.time < limit) store.delete(k);
}

/** Misc::randNumber(6): prima cifra 1-9, poi 0-9 */
export function randNumber(len = 6): string {
  let out = String(randomInt(1, 10));
  while (out.length < len) out += String(randomInt(0, 10));
  return out;
}

export function newMfaKey(): string {
  return randomBytes(18).toString("base64url");
}

/** Configurazione 2FA dell'agente (Staff::get2FAConfig): JSON nella config "staff.<id>". */
export function staff2faConfig(config: ConfigNamespace, id = EMAIL_2FA): { config?: { email?: string; external2fa?: boolean }; verified?: number } {
  const raw = config.str(id);
  if (!raw) return {};
  const parsed = phpJsonDecode<Record<string, unknown>>(raw, {});
  return parsed && typeof parsed === "object" ? (parsed as { config?: { email?: string }; verified?: number }) : {};
}

/**
 * Email2FABackend::send($staff): richiede la configurazione del backend; codice di 6 cifre memorizzato
 * con la chiave `key`; email "email2fa-staff" dall'email di avviso (o predefinita) all'indirizzo
 * principale dell'agente (stranezza del PHP: l'indirizzo configurato per il 2FA non viene usato).
 * Restituisce la funzione di invio (da eseguire dopo il commit) o false.
 */
export async function prepare2faEmail(
  executor: DbOrTx,
  cfg: ConfigNamespace,
  staff: { id: number; config: ConfigNamespace },
  key: string,
): Promise<(() => Promise<void>) | false> {
  if (!Object.keys(staff2faConfig(staff.config)).length) return false;
  const email = await alertOrDefaultEmail(executor, cfg);
  if (!email) return false;
  const otp = randNumber(6);
  sweep();
  store.set(key, { staffId: staff.id, otp, time: Math.floor(Date.now() / 1000), strikes: 0 });
  const page = await loadContentPage(executor, "email2fa-staff");
  const info = await loadStaffInfo(executor, staff.id);
  if (!page || !info) return false;
  const v = staffVar(info, cfg);
  return sendContentMail(executor, cfg, { email, page, vars: { otp, staff: v, recipient: v }, to: { name: "", address: info.email } });
}

export type OtpCheck = "ok" | "invalid" | "expired" | "too_many" | "missing";

/** TwoFactorAuthenticationBackend::_validate($otp, $strict=true) */
export function validateOtp(key: string, staffId: number, otp: string): OtpCheck {
  const s = store.get(key);
  if (!s || s.staffId !== staffId) return "missing";
  // validatore "number" del campo token: un formato errato invalida il form prima del conteggio
  if (!/^\d+$/.test(otp.trim())) return "invalid";
  s.strikes += 1;
  if (s.strikes > MAX_STRIKES) {
    store.delete(key);
    return "too_many";
  }
  if (s.time + TIMEOUT_MIN * 60 < Date.now() / 1000) {
    store.delete(key);
    return "expired";
  }
  if (s.otp !== otp.trim()) return "invalid";
  store.delete(key);
  return "ok";
}

/** Solo per i test: codice pendente di una chiave. */
export function pendingOtpForTests(key: string): string | null {
  return store.get(key)?.otp ?? null;
}
