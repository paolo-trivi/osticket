import "server-only";

import { randomBytes } from "node:crypto";

import { jwtVerify, SignJWT } from "jose";
import { cookies, headers } from "next/headers";

import { sessionSecret } from "../env";
import { resolveClientIp } from "./client-ip";
import { isSessionRevoked, revokeSession } from "./revocation";

/**
 * Sessioni della app Next: cookie firmati (JWT HS256), separati dalla sessione PHP (OSTSESSID).
 * Le regole replicano quelle di osTicket (doc 09 §7): timeout di inattività da config
 * (staff_/client_session_timeout), binding all'IP opzionale, invalidazione se cambia la password
 * (campo passwdreset) o se l'account viene disattivato (verificato a ogni richiesta).
 *
 * Il PHP distrugge la sessione sul server al logout; un cookie firmato invece resterebbe valido. Ogni
 * sessione ha quindi un id casuale (`sid`, anche `jti` del JWT) che il logout mette in una lista di revoca
 * in memoria (revocation.ts) fino alla scadenza, e una durata massima assoluta di MAX_SESSION_HOURS dal
 * login, applicata anche con staff_/client_session_timeout = 0 (nessun timeout di inattività).
 * Come codici 2FA e tentativi falliti, la lista vive nel processo: una sola istanza della app.
 */
export type Realm = "staff" | "client";

export interface SessionPayload {
  realm: Realm;
  /** staff_id oppure user_id */
  uid: number;
  /** valore di passwdreset al login: se cambia, la sessione decade */
  pwv: string;
  ip: string;
  /** ultimo accesso (secondi epoch) per il timeout di inattività */
  last: number;
  /** login iniziato ma secondo fattore non ancora verificato */
  mfa?: "pending";
  /** chiave del codice 2FA pendente (lo stato è lato server, src/server/auth/mfa.ts) */
  mfk?: string;
  /** token di reset password usato per il login ($_SESSION['_staff']['reset-token']) */
  rst?: string;
  /** id casuale della sessione (jti), per la revoca al logout */
  sid: string;
  /** inizio della sessione (secondi epoch), per la durata massima assoluta */
  born: number;
}

/** Durata massima assoluta di una sessione, qualunque sia il timeout di inattività configurato. */
export const MAX_SESSION_HOURS = 12;
const MAX_SESSION_SEC = MAX_SESSION_HOURS * 3600;

/** Dati di una nuova sessione: id e inizio si generano qui; le riscritture li conservano. */
type NewSession = Omit<SessionPayload, "sid" | "born"> & Partial<Pick<SessionPayload, "sid" | "born">>;

const COOKIE: Record<Realm, string> = {
  staff: "ostn_staff",
  client: "ostn_client",
};

/** IP del client della richiesta corrente (header del reverse proxy, vedi client-ip.ts). */
export async function clientIp(): Promise<string> {
  return resolveClientIp(await headers());
}

export async function writeSession(data: NewSession): Promise<void> {
  const payload: SessionPayload = {
    ...data,
    sid: data.sid ?? randomBytes(16).toString("base64url"),
    born: data.born ?? Math.floor(Date.now() / 1000),
  };
  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setJti(payload.sid)
    .setExpirationTime(payload.born + MAX_SESSION_SEC)
    .sign(sessionSecret());
  (await cookies()).set(COOKIE[payload.realm], token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

export async function readSession(realm: Realm): Promise<SessionPayload | null> {
  const token = (await cookies()).get(COOKIE[realm])?.value;
  if (!token) return null;
  try {
    // jwtVerify rifiuta i token scaduti (exp = born + MAX_SESSION_SEC)
    const { payload } = await jwtVerify(token, sessionSecret(), { algorithms: ["HS256"] });
    if (payload.realm !== realm || typeof payload.uid !== "number") return null;
    if (typeof payload.sid !== "string" || !payload.sid || typeof payload.born !== "number") return null;
    if (Math.floor(Date.now() / 1000) - payload.born > MAX_SESSION_SEC) return null;
    if (isSessionRevoked(payload.sid)) return null;
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

/** Logout: sessione revocata sul server (fino alla sua scadenza) e cookie eliminato. */
export async function clearSession(realm: Realm): Promise<void> {
  const session = await readSession(realm);
  if (session) revokeSession(session.sid, session.born + MAX_SESSION_SEC);
  (await cookies()).delete(COOKIE[realm]);
}
