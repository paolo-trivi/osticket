import "server-only";

import { randomBytes } from "node:crypto";

import { cookies } from "next/headers";
import { cache } from "react";

import { coreConfig } from "../config/config";
import { db } from "../db";
import { detectDbTimezone } from "../db/time";
import type { ClientLogin } from "../domain/client/auth";
import { accountIsActive, loadClientIdentity, passwordVersion, type ClientIdentity, type GuestAccess } from "../domain/client/identity";
import { logSystem } from "../system/syslog";
import { clearSession, clientIp, readSession, writeSession, type SessionPayload } from "./session";

/**
 * Sessione dei clienti del portale: cookie firmato separato da quello degli agenti (realm "client",
 * cookie ostn_client, vedi session.ts), equivalente di $_SESSION['_auth']['user'] + ClientSession.
 * Ogni richiesta ricontrolla l'utente come UserAuthenticationBackend::getUser/validate:
 *  - utente registrato: account esistente, confermato e non bloccato, password non cambiata
 *    (al cambio password il PHP cancella le altre sessioni: qui decade la versione nel cookie);
 *  - ospite (link al ticket): il ticket esiste e l'utente ne è ancora proprietario o collaboratore;
 *  - timeout di inattività client_session_timeout.
 */
interface ClientSessionPayload extends SessionPayload {
  /** accesso ospite (ticket e collaboratore) */
  g?: GuestAccess;
  /** chiave casuale della sessione (equivalente di session_id() per lo spazio dei nomi delle bozze) */
  csk?: string;
}

async function readClientSession(): Promise<ClientSessionPayload | null> {
  return (await readSession("client")) as ClientSessionPayload | null;
}

/** Apre la sessione del cliente dopo un login riuscito */
export async function startClientSession(login: ClientLogin): Promise<void> {
  const ip = await clientIp();
  const payload: ClientSessionPayload = {
    realm: "client",
    uid: login.userId,
    pwv: login.pwv,
    ip,
    last: Math.floor(Date.now() / 1000),
    csk: randomBytes(16).toString("hex"),
    ...(login.guest ? { g: login.guest } : {}),
    ...(login.resetToken ? { rst: login.resetToken } : {}),
  };
  await writeSession(payload);
}

/** Cliente della richiesta corrente, o null */
export const currentClient = cache(async (): Promise<ClientIdentity | null> => {
  const s = await readClientSession();
  if (!s) return null;
  const cfg = await coreConfig();
  await detectDbTimezone(db());
  const timeout = cfg.int("client_session_timeout") * 60;
  if (timeout > 0 && Math.floor(Date.now() / 1000) - s.last > timeout) return null;
  const client = await loadClientIdentity(s.uid, s.g ?? null);
  if (!client) return null;
  if (client.account && !accountIsActive(client.account)) return null;
  if (!s.g) {
    if (!client.account) return null;
    if (passwordVersion(client.account.passwd) !== s.pwv) return null;
  } else {
    // AuthTokenAuthentication/AccessLinkAuthentication::validate: proprietario o collaboratore del ticket
    const t = await db().selectFrom("ticket").select(["ticket_id", "user_id"]).where("ticket_id", "=", s.g.ticketId).executeTakeFirst();
    if (!t) return null;
    if (s.g.collabId) {
      const c = await db().selectFrom("thread_collaborator").select("user_id").where("id", "=", s.g.collabId).executeTakeFirst();
      if (!c || c.user_id !== s.uid) return null;
    } else if (t.user_id !== s.uid) return null;
  }
  return client;
});

/** Rinnova il timestamp di attività (Server Actions e route handler) */
export async function touchClientSession(): Promise<void> {
  const s = await readClientSession();
  if (s) await writeSession({ ...s, last: Math.floor(Date.now() / 1000) } as SessionPayload);
}

/** Chiave della sessione per le bozze `ticket.client.<ultimi 12 caratteri>` (anche per i visitatori) */
async function clientSessionKey(): Promise<string> {
  return (await readClientSession())?.csk ?? "";
}

/** Token di reset password della sessione ($_SESSION['_client']['reset-token']) */
export async function clientResetToken(): Promise<string | null> {
  return (await readClientSession())?.rst ?? null;
}

/** Dopo il cambio password: nuova versione nel cookie e token di reset rimosso (cancelResetTokens) */
export async function refreshClientSession(pwv: string): Promise<void> {
  const s = await readClientSession();
  if (!s) return;
  const next: ClientSessionPayload = { ...s, pwv, last: Math.floor(Date.now() / 1000) };
  delete next.rst;
  await writeSession(next);
}

/** logout.php → UserAuthenticationBackend::signOut: syslog "User logout" (Debug) e cookie eliminato */
export async function clientLogout(): Promise<void> {
  const client = await currentClient();
  if (client) {
    const ip = await clientIp();
    await logSystem("Debug", "User logout", `${client.email} logged out [${ip}]`, ip);
  }
  await clearSession("client");
}

const ANON_COOKIE = "ostn_client_anon";

/**
 * Chiave del visitatore non autenticato (allegati e bozze degli ospiti che aprono un ticket): cookie
 * casuale httpOnly creato al primo upload. Da usare solo in Server Actions e route handler.
 */
export async function visitorKey(create = false): Promise<string> {
  const session = await clientSessionKey();
  if (session) return session;
  const jar = await cookies();
  const cur = jar.get(ANON_COOKIE)?.value;
  if (cur && /^[a-f0-9]{32}$/.test(cur)) return cur;
  if (!create) return "";
  const key = randomBytes(16).toString("hex");
  jar.set(ANON_COOKIE, key, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  return key;
}
