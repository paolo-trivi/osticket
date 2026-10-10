import "server-only";

import { createHash } from "node:crypto";

import { OrganizationModel, UserAccountStatus, UserModel } from "@/lib/osticket/flags";

import type { ConfigNamespace } from "../../config/config";
import { db, type DbOrTx } from "../../db";
import { PersonsName } from "../../format/persons-name";
import { usernameError } from "../admin/validator";
import { isEmail } from "../forms/validator";

/**
 * Utente del portale clienti: equivalente di EndUser / ClientSession / ClientAccount
 * (include/class.client.php, class.user.php, class.usersession.php).
 */

export interface ClientAccountRow {
  id: number;
  user_id: number;
  status: number;
  timezone: string | null;
  lang: string | null;
  username: string | null;
  passwd: string | null;
  backend: string | null;
  extra: string | null;
}

/** Accesso "ospite" da link (TicketOwner/Collaborator con flagGuest): ticket e collaboratore (0 = proprietario). */
export interface GuestAccess {
  ticketId: number;
  collabId: number;
}

export interface ClientIdentity {
  /** user.id */
  id: number;
  name: string;
  /** indirizzo dell'email predefinita */
  email: string;
  orgId: number;
  /** user.status (bit 1 = contatto primario dell'organizzazione) */
  status: number;
  account: ClientAccountRow | null;
  guest: GuestAccess | null;
  /** organizzazione condivisa con l'utente (User::canSeeOrgTickets) */
  canSeeOrgTickets: boolean;
}

export const accountIsConfirmed = (a: Pick<ClientAccountRow, "status">) => (a.status & UserAccountStatus.CONFIRMED) !== 0;
export const accountIsLocked = (a: Pick<ClientAccountRow, "status">) => (a.status & UserAccountStatus.LOCKED) !== 0;
/** UserAccount::isActive */
export const accountIsActive = (a: Pick<ClientAccountRow, "status">) => accountIsConfirmed(a) && !accountIsLocked(a);

/**
 * Versione della password per invalidare le sessioni dopo un cambio (equivalente del Signal
 * auth.clean → PasswordPolicy::cleanSessions, che nel PHP cancella le sessioni dell'utente).
 */
export function passwordVersion(passwd: string | null | undefined): string {
  return createHash("sha256").update(passwd ?? "").digest("base64url").slice(0, 16);
}

export async function loadClientAccount(executor: DbOrTx, userId: number, forUpdate = false): Promise<ClientAccountRow | null> {
  let q = executor
    .selectFrom("user_account")
    .select(["id", "user_id", "status", "timezone", "lang", "username", "passwd", "backend", "extra"])
    .where("user_id", "=", userId)
    .orderBy("id");
  if (forUpdate) q = q.forUpdate();
  return (await q.executeTakeFirst()) ?? null;
}

/** Validator::is_userid: username valido o indirizzo email */
export function isUserId(v: string): boolean {
  return usernameError(v) === "" || isEmail(v);
}

/**
 * ClientAccount::lookupByUsername: per indirizzo (uno qualunque degli indirizzi dell'utente) se è
 * un'email, altrimenti per user_account.username.
 */
export async function lookupAccountByUsername(executor: DbOrTx, username: string): Promise<ClientAccountRow | null> {
  const cols = ["a.id", "a.user_id", "a.status", "a.timezone", "a.lang", "a.username", "a.passwd", "a.backend", "a.extra"] as const;
  if (isEmail(username)) {
    return (
      (await executor
        .selectFrom("user_account as a")
        .innerJoin("user_email as e", "e.user_id", "a.user_id")
        .select(cols)
        .where("e.address", "=", username)
        .orderBy("a.id")
        .executeTakeFirst()) ?? null
    );
  }
  if (usernameError(username) === "") {
    return (await executor.selectFrom("user_account as a").select(cols).where("a.username", "=", username).executeTakeFirst()) ?? null;
  }
  return null;
}

/** Utente del portale (EndUser) con account e permessi sull'organizzazione. */
export async function loadClientIdentity(userId: number, guest: GuestAccess | null = null, executor: DbOrTx = db()): Promise<ClientIdentity | null> {
  const u = await executor
    .selectFrom("user as u")
    .leftJoin("user_email as e", "e.id", "u.default_email_id")
    .leftJoin("organization as o", "o.id", "u.org_id")
    .select(["u.id", "u.name", "u.org_id", "u.status", "e.address", "o.id as oid", "o.status as ostatus"])
    .where("u.id", "=", userId)
    .executeTakeFirst();
  if (!u) return null;
  const account = await loadClientAccount(executor, userId);
  const ost = u.ostatus ?? 0;
  const canSeeOrgTickets = !!u.oid && (!!(ost & OrganizationModel.SHARE_EVERYBODY) || (!!(u.status & UserModel.PRIMARY_ORG_CONTACT) && !!(ost & OrganizationModel.SHARE_PRIMARY_CONTACT)));
  return { id: u.id, name: u.name, email: u.address ?? "", orgId: u.org_id, status: u.status, account, guest, canSeeOrgTickets };
}

/** (string) User::getName() nel formato client_name_format */
export function clientDisplayName(c: Pick<ClientIdentity, "name" | "email">, cfg: ConfigNamespace): string {
  return new PersonsName(c.name || c.email.split("@")[0], cfg.str("client_name_format")).toString();
}

