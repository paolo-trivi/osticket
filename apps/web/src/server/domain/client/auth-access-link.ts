import "server-only";

import { createHash } from "node:crypto";

import { ObjectType } from "@/lib/osticket/object-types";

import { db, type DbOrTx } from "../../db";
import { installConfig } from "../../env";
import { base32Decode, ticketAuthToken } from "../../mail/message-id";
import { isEmail } from "../forms/validator";
import { type ClientAuthError, type ClientAuthOutcome, type ClientLogin, denied, lockedOut, loginWrites, prepare, strike } from "./auth";
import type { GuestAccess } from "./identity";
import { sendAccessLinkMail } from "./mails";

/**
 * Accesso dei clienti come ospiti di un ticket: link di accesso con email e numero del ticket
 * (AccessLinkAuthentication) e link firmati `?auth=` delle email (AuthTokenAuthentication).
 */

/** Ticket::lookupByNumber($number) */
async function ticketByNumber(executor: DbOrTx, number: string) {
  if (!number) return null;
  return (await executor.selectFrom("ticket").select(["ticket_id", "user_id", "created", "number"]).where("number", "=", number).executeTakeFirst()) ?? null;
}

/** AccessLinkAuthentication::_getTicketUser: proprietario o collaboratore del ticket */
async function ticketUser(executor: DbOrTx, ticket: { ticket_id: number; user_id: number }, userId: number): Promise<GuestAccess | null> {
  if (ticket.user_id === userId) return { ticketId: ticket.ticket_id, collabId: 0 };
  const c = await executor
    .selectFrom("thread_collaborator as c")
    .innerJoin("thread as th", "th.id", "c.thread_id")
    .select("c.id")
    .where("th.object_type", "=", ObjectType.TICKET)
    .where("th.object_id", "=", ticket.ticket_id)
    .where("c.user_id", "=", userId)
    .executeTakeFirst();
  return c ? { ticketId: ticket.ticket_id, collabId: c.id } : null;
}

type AccessLinkOutcome = { ok: true; sent: true } | ({ ok: true; sent: false } & ClientLogin) | { ok: false; error: ClientAuthError };

/**
 * login.php (POST lemail/lticket) → AccessLinkAuthentication. Con client_verify_email (default) invia
 * l'email "access-link" con il link firmato e non apre la sessione; altrimenti accesso diretto
 * come ospite. Ogni fallimento è un tentativo (strike).
 */
export async function performAccessLink(input: { email: string; number: string; ip: string }): Promise<AccessLinkOutcome> {
  const cfg = await prepare();
  const { ip } = input;
  const email = input.email.trim();
  if (!isEmail(email)) return { ok: false, error: "invalid_email" };
  if (lockedOut(cfg, ip)) {
    await strike(cfg, email, ip);
    return { ok: false, error: "locked_out" };
  }
  const ticket = await ticketByNumber(db(), String(input.number ?? "").trim());
  const user = await db().selectFrom("user_email").select("user_id").where("address", "=", email).executeTakeFirst();
  const guest = ticket && user ? await ticketUser(db(), ticket, user.user_id) : null;
  if (!ticket || !user || !guest) {
    await strike(cfg, email, ip);
    return { ok: false, error: "invalid" };
  }
  if (cfg.bool("client_verify_email")) {
    // AccessLinkAuthentication::login non apre la sessione; login.php invia il link (Ticket::sendAccessLink)
    await sendAccessLinkMail(db(), cfg, ticket.ticket_id, user.user_id, guest.collabId);
    return { ok: true, sent: true };
  }
  const r = await db()
    .transaction()
    .execute((tx) => loginWrites(tx, cfg, user.user_id, { ip, interactive: false }));
  if (!r.ok) {
    await strike(cfg, email, ip);
    return { ok: false, error: r.error };
  }
  return { ok: true, sent: false, userId: user.user_id, pwv: r.pwv, guest };
}

/** TicketUser::lookupByToken: ospite (proprietario o collaboratore) di un link `?auth=` */
async function lookupByAuthToken(executor: DbOrTx, token: string): Promise<{ userId: number; guest: GuestAccess } | null> {
  const m = /^(\w)(\d+)x(.*)$/i.exec(token);
  if (!m) return null;
  const packed = base32Decode(m[3].slice(0, 13).toLowerCase());
  if (packed.length < 8) return null;
  const uid = packed.readUInt32LE(0);
  const tid = packed.readUInt32LE(4);
  const ticket = await executor.selectFrom("ticket").select(["ticket_id", "user_id", "created"]).where("ticket_id", "=", tid).executeTakeFirst();
  if (!ticket) return null;
  let userId = 0;
  let guest: GuestAccess | null = null;
  let contactId = 0;
  if (m[1] === "c") {
    const c = await executor
      .selectFrom("thread_collaborator as c")
      .innerJoin("thread as th", "th.id", "c.thread_id")
      .select(["c.id", "c.user_id", "th.object_id", "th.object_type"])
      .where("c.id", "=", uid)
      .executeTakeFirst();
    if (c && c.object_type === ObjectType.TICKET && c.object_id === tid) {
      userId = c.user_id;
      contactId = c.id;
      guest = { ticketId: tid, collabId: c.id };
    }
  } else if (m[1] === "o") {
    if (ticket.user_id === uid) {
      userId = uid;
      contactId = uid;
      guest = { ticketId: tid, collabId: 0 };
    }
  }
  if (!guest) return null;
  // Ticket::getAuthToken: 'o' se l'id del contatto coincide con il proprietario (anche per un collaboratore)
  const expected = ticketAuthToken({
    isOwner: contactId === ticket.user_id,
    contactId,
    ticketId: tid,
    createDate: ticket.created,
    secretSalt: installConfig().secretSalt,
    algo: Number(m[2]),
  });
  if (Number(m[2]) !== 1 || expected.toLowerCase() !== token.toLowerCase()) return null;
  return { userId, guest };
}

/**
 * view.php?auth=<token> (o i vecchi link ?t=&e=&a=) → AuthTokenAuthentication::signOn tramite
 * processSignOn senza autenticazione forzata: token non valido = nessun accesso, senza strike.
 */
export async function performTokenSignOn(input: { auth?: string; t?: string; e?: string; a?: string; ip: string }): Promise<ClientAuthOutcome | null> {
  const cfg = await prepare();
  const { ip } = input;
  if (lockedOut(cfg, ip)) return denied(cfg, "", ip, "locked_out");
  if (!cfg.bool("allow_auth_tokens")) return null;
  let found: { userId: number; guest: GuestAccess } | null = null;
  if (input.auth) found = await lookupByAuthToken(db(), input.auth);
  else if (input.t && input.e && input.a) {
    // Vecchi token: md5(ticket_id . strtolower(email) . SECRET_SALT), solo per il proprietario
    const row = await db()
      .selectFrom("ticket as t")
      .innerJoin("user_email as e", "e.user_id", "t.user_id")
      .select(["t.ticket_id", "t.user_id"])
      .where("t.number", "=", input.t)
      .where("e.address", "=", input.e)
      .executeTakeFirst();
    const md5 = row ? createHash("md5").update(`${row.ticket_id}${input.e.toLowerCase()}${installConfig().secretSalt}`).digest("hex") : "";
    if (row && md5 === input.a.toLowerCase()) found = { userId: row.user_id, guest: { ticketId: row.ticket_id, collabId: 0 } };
  }
  if (!found) return null;
  const f = found;
  const r = await db()
    .transaction()
    .execute((tx) => loginWrites(tx, cfg, f.userId, { ip, interactive: false }));
  if (!r.ok) return denied(cfg, "", ip, r.error);
  return { ok: true, userId: f.userId, pwv: r.pwv, guest: f.guest };
}
