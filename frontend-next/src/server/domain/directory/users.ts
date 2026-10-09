import "server-only";

import { sql } from "kysely";

import { NOW, table, type DbOrTx } from "../../db";
import { htmlDecode } from "../../format/html";
import { sanitizeText, searchable } from "../../format/text";
import { deleteSearchRow, replaceSearchRow } from "../search/index-writer";
import { GlobalPerm } from "../staff/staff";
import { lookupUserByEmail, normalizeUserName, organizationForDomain } from "../ticket/create-user";
import type { WriteContext } from "../ticket/context";
import { phpLooseEquals } from "../ticket/record";
import {
  createEntry,
  defaultFormOf,
  deleteEntries,
  entriesFor,
  entriesSearchable,
  hasAnswerRow,
  inputFor,
  isEditableToStaff,
  isEmail,
  isRequiredForStaff,
  isVisibleToStaff,
  parseInput,
  saveEntryAnswers,
  toDatabase,
  validateInput,
  verifyEmailFields,
  type FieldDef,
  type FormEntry,
} from "./forms";

/**
 * Utenti finali (include/class.user.php, scp/users.php, include/ajax.users.php) con le stesse righe
 * del PHP: user, user_email, form_entry(_values), user__cdata, _search (Signal user.created /
 * model.updated / model.deleted del MysqlSearchBackend).
 */

export type DirError =
  | "forbidden" | "not_found" | "invalid" | "email_in_use" | "has_tickets" | "tickets_delete_unsupported"
  | "already_registered" | "no_account" | "already_confirmed" | "name_in_use" | "send_failed" | "import";

export type DirResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: DirError; fields?: Record<string, string>; detail?: string };

export const UserStatus = { PRIMARY_ORG_CONTACT: 0x0001 } as const;

export interface UserCore {
  id: number;
  org_id: number;
  default_email_id: number;
  status: number;
  name: string;
}

export async function loadUserCore(executor: DbOrTx, id: number, forUpdate = false): Promise<UserCore | null> {
  let q = executor.selectFrom("user").select(["id", "org_id", "default_email_id", "status", "name"]).where("id", "=", id);
  if (forUpdate) q = q.forUpdate();
  return (await q.executeTakeFirst()) ?? null;
}

/** Indirizzi della relazione emails (ordine della tabella). */
async function userEmails(executor: DbOrTx, userId: number): Promise<string[]> {
  const rows = await executor.selectFrom("user_email").select("address").where("user_id", "=", userId).orderBy("id").execute();
  return rows.map((r) => r.address);
}

/**
 * SearchBackend::updateModel(User): risposte dei form (tranne `subject`), più gli indirizzi email
 * accodati da MysqlSearchBackend::update; titolo = nome. `emails` permette di replicare la relazione
 * in cache del PHP (alla creazione contiene due volte l'indirizzo appena aggiunto).
 */
export async function reindexUser(executor: DbOrTx, userId: number, emails?: string[]): Promise<void> {
  const u = await executor.selectFrom("user").select(["name"]).where("id", "=", userId).executeTakeFirst();
  if (!u) return;
  const entries = await entriesFor(executor, "U", userId);
  const content = entriesSearchable(entries).join("\n").trim();
  const list = emails ?? (await userEmails(executor, userId));
  await replaceSearchRow(executor, "U", userId, `${content} ${list.join("\n")}`, searchable(u.name));
}

/** Filtro di validazione di User::fromForm con un agente: obbligatorio o visibile all'agente. */
const staffFilter = (f: FieldDef) => isRequiredForStaff(f) || isVisibleToStaff(f);

/** Valore pulito (getClean) di un campo per nome. */
function cleanOf(fields: FieldDef[], input: Record<string, unknown>, name: string): string {
  const f = fields.find((x) => x.name === name);
  if (!f) return "";
  const v = parseInput(f, inputFor(input, f));
  if (v === null || v === false) return "";
  if (typeof v === "object") return Object.values(v).join(", ");
  return String(v);
}

/** UserEmail::ensure */
async function ensureUserEmail(executor: DbOrTx, address: string): Promise<number> {
  const row = await executor.selectFrom("user_email").select("id").where("address", "=", address).executeTakeFirst();
  if (row) return row.id;
  const r = await executor.insertInto("user_email").values({ user_id: 0, flags: 0, address }).executeTakeFirstOrThrow();
  return Number(r.insertId);
}

/**
 * User::fromVars($vars, $create=true): nuovo utente con email predefinita, organizzazione (org_id o
 * dominio), entry del form utente e indice. `input` è la sorgente del form (valori grezzi).
 */
async function userFromVars(executor: DbOrTx, input: Record<string, unknown>, orgId?: number): Promise<UserCore | null> {
  const form = await defaultFormOf(executor, "U");
  if (!form) return null;
  const email = cleanOf(form.fields, input, "email");
  const existing = await lookupUserByEmail(executor, email);
  if (existing) return existing;
  if (!isEmail(email)) return null;
  let name = cleanOf(form.fields, input, "name");
  if (!name) name = email.split("@")[0];
  name = normalizeUserName(htmlDecode(sanitizeText(name)).trim());

  const emailId = await ensureUserEmail(executor, email);
  let org = 0;
  if (orgId !== undefined) org = orgId;
  else {
    const o = await organizationForDomain(executor, email.split("@")[1] ?? "");
    if (o) org = o.id;
  }
  const res = await executor
    .insertInto("user")
    .values({ org_id: org, default_email_id: emailId, status: 0, name, created: NOW, updated: NOW })
    .executeTakeFirstOrThrow();
  const id = Number(res.insertId);
  await executor.updateTable("user_email").set({ user_id: id }).where("id", "=", emailId).execute();
  await createEntry(executor, form, "U", "U", id, input);
  // user.created: la relazione emails in cache contiene l'indirizzo due volte (fetch + add)
  await reindexUser(executor, id, [email, email]);
  return { id, org_id: org, default_email_id: emailId, status: 0, name };
}

/**
 * User::fromForm($form) da scp/users.php (do=create) e ajax.users.php:addUser: validazione dei campi
 * visibili/obbligatori per l'agente ed email non già assegnata.
 * Permessi: scp/users.php non controlla user.create (bug di permessi del PHP, non replicato).
 */
export async function createUser(ctx: WriteContext, input: Record<string, unknown>, opts: { orgId?: number; checkPerm?: boolean } = {}): Promise<DirResult<{ id: number }>> {
  const { tx, agent } = ctx;
  if (opts.checkPerm !== false && (!agent || !agent.hasGlobalPerm(GlobalPerm.USER_CREATE))) return { ok: false, error: "forbidden" };
  const form = await defaultFormOf(tx, "U");
  if (!form) return { ok: false, error: "not_found" };
  const fields = validateInput(form.fields, input, staffFilter);
  if (!Object.keys(fields).length) Object.assign(fields, await verifyEmailFields(form.fields, input, ctx.cfg.bool("verify_email_addrs"), staffFilter));
  const email = cleanOf(form.fields, input, "email");
  if (email && (await lookupUserByEmail(tx, email))) fields.email = "in_use";
  if (Object.keys(fields).length) return { ok: false, error: "invalid", fields };
  const user = await userFromVars(tx, input, opts.orgId);
  if (!user) return { ok: false, error: "invalid" };
  return { ok: true, id: user.id };
}

/**
 * Salvataggio di User (User::save): normalizza il nome; con modifiche updated = NOW e reindicizzazione.
 * Il nome è "sporco" se il valore assegnato (prima della normalizzazione) differisce da quello attuale,
 * anche se poi la normalizzazione lo riporta uguale (ORM PHP: il campo resta nell'elenco dirty).
 */
async function saveUser(
  executor: DbOrTx,
  user: UserCore,
  changes: Partial<Pick<UserCore, "name" | "org_id" | "status">>,
  touch = false,
  cachedEmails?: string[],
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (changes.name !== undefined && !phpLooseEquals(user.name, changes.name)) set.name = normalizeUserName(changes.name);
  if (changes.org_id !== undefined && !phpLooseEquals(user.org_id, changes.org_id)) set.org_id = changes.org_id;
  if (changes.status !== undefined && !phpLooseEquals(user.status, changes.status)) set.status = changes.status;
  if (!Object.keys(set).length && !touch) return;
  set.updated = NOW;
  await executor.updateTable("user").set(set as never).where("id", "=", user.id).execute();
  Object.assign(user, set);
  await reindexUser(executor, user.id, cachedEmails);
}

/** User::getForms($vars, $isEditable) + validazione isValidForStaff(true) */
async function userEntries(executor: DbOrTx, userId: number): Promise<FormEntry[]> {
  const entries = await entriesFor(executor, "U", userId);
  if (!entries.length) {
    // getDynamicData($create=true): entry vuota del form utente
    const form = await defaultFormOf(executor, "U");
    if (form) {
      await createEntry(executor, form, "U", "U", userId, {});
      return entriesFor(executor, "U", userId);
    }
  }
  return entries;
}

/** User::updateInfo($vars, $errors, $staff=true) (ajax.users.php:updateUser, scp/users.php do=update) */
export async function updateUser(ctx: WriteContext, userId: number, input: Record<string, unknown>): Promise<DirResult> {
  if (!ctx.agent || !ctx.agent.hasGlobalPerm(GlobalPerm.USER_EDIT)) return { ok: false, error: "forbidden" };
  return updateUserInfo(ctx, userId, input);
}

async function updateUserInfo(ctx: WriteContext, userId: number, input: Record<string, unknown>): Promise<DirResult> {
  const { tx } = ctx;
  const user = await loadUserCore(tx, userId, true);
  if (!user) return { ok: false, error: "not_found" };
  const entries = await userEntries(tx, userId);
  const fields: Record<string, string> = {};
  for (const e of entries) {
    const errs = validateInput(e.fields, input, isEditableToStaff);
    Object.assign(fields, errs, Object.keys(errs).length ? {} : await verifyEmailFields(e.fields, input, ctx.cfg.bool("verify_email_addrs"), isEditableToStaff));
    if (e.form_type === "U") {
      const f = e.fields.find((x) => x.name === "email");
      if (f && isEditableToStaff(f)) {
        const email = cleanOf(e.fields, input, "email");
        const other = email ? await lookupUserByEmail(tx, email) : null;
        if (other && other.id !== userId) fields.email = "in_use";
      }
    }
  }
  if (Object.keys(fields).length) return { ok: false, error: "invalid", fields };

  let name: string | undefined;
  let touch = false;
  for (const e of entries) {
    if (e.form_type === "U") {
      const nf = e.fields.find((x) => x.name === "name");
      if (nf && isEditableToStaff(nf)) name = cleanOf(e.fields, input, "name").trim();
      const ef = e.fields.find((x) => x.name === "email");
      if (ef && isEditableToStaff(ef)) {
        const email = cleanOf(e.fields, input, "email");
        const cur = await tx.selectFrom("user_email").select(["id", "address"]).where("id", "=", user.default_email_id).executeTakeFirst();
        if (cur && !phpLooseEquals(cur.address, email)) {
          await tx.updateTable("user_email").set({ address: email }).where("id", "=", cur.id).execute();
        }
      }
    }
    // Widget::getValue: i campi assenti dalla sorgente mantengono il valore attuale
    const r = await saveEntryAnswers(tx, e, userId, input, { isEditable: (f) => isEditableToStaff(f) && hasAnswerRow(f), onlyProvided: true });
    if (r.dirty) touch = true;
  }
  await saveUser(tx, user, name !== undefined ? { name } : {}, touch);
  return { ok: true };
}

/** User::setOrganization($org) (ajax.users.php:updateOrg, azione di massa setorg) */
/**
 * `justCreated`: utente appena creato nella stessa richiesta (la relazione emails in cache del PHP
 * contiene ancora l'indirizzo due volte, e finisce così nell'indice).
 */
export async function setUserOrganization(ctx: WriteContext, userId: number, orgId: number, checkPerm = true, justCreated = false): Promise<DirResult> {
  const { tx, agent } = ctx;
  if (checkPerm && (!agent || !agent.hasGlobalPerm(GlobalPerm.USER_EDIT))) return { ok: false, error: "forbidden" };
  const user = await loadUserCore(tx, userId, true);
  if (!user) return { ok: false, error: "not_found" };
  const org = await tx.selectFrom("organization").select("id").where("id", "=", orgId).executeTakeFirst();
  if (!org) return { ok: false, error: "not_found" };
  let cached: string[] | undefined;
  if (justCreated) {
    const e = await tx.selectFrom("user_email").select("address").where("id", "=", user.default_email_id).executeTakeFirst();
    cached = e ? [e.address, e.address] : undefined;
  }
  await saveUser(tx, user, { org_id: org.id }, false, cached);
  return { ok: true };
}

/** Organization::removeUser($user): org_id azzerato e flag di contatto principale rimosso. */
export async function removeUserFromOrg(ctx: WriteContext, userId: number): Promise<boolean> {
  const user = await loadUserCore(ctx.tx, userId, true);
  if (!user) return false;
  await saveUser(ctx.tx, user, { org_id: 0, status: user.status & ~UserStatus.PRIMARY_ORG_CONTACT });
  return true;
}

/**
 * User::delete(): rifiutata con ticket; account, email, entry dei form (le righe user__cdata restano),
 * utente e indice. Con `deleteTickets` il PHP elimina prima i ticket (User::deleteAllTickets →
 * Ticket::setStatus(deleted)): richiede l'eliminazione dei ticket (area ticketedit), passata come `hardDelete`.
 */
export async function deleteUser(
  ctx: WriteContext,
  userId: number,
  opts: { deleteTickets?: boolean; hardDeleteTicket?: (ctx: WriteContext, ticketId: number) => Promise<boolean>; checkPerm?: boolean } = {},
): Promise<DirResult> {
  const { tx, agent } = ctx;
  if (opts.checkPerm !== false && (!agent || !agent.hasGlobalPerm(GlobalPerm.USER_DELETE))) return { ok: false, error: "forbidden" };
  const user = await loadUserCore(tx, userId, true);
  if (!user) return { ok: false, error: "not_found" };
  const tickets = await tx.selectFrom("ticket").select("ticket_id").where("user_id", "=", userId).orderBy("ticket_id").execute();
  if (tickets.length) {
    if (!opts.deleteTickets) return { ok: false, error: "has_tickets" };
    if (!opts.hardDeleteTicket) return { ok: false, error: "tickets_delete_unsupported" };
    for (const t of tickets) if (!(await opts.hardDeleteTicket(ctx, t.ticket_id))) return { ok: false, error: "forbidden" };
    const left = await tx.selectFrom("ticket").select("ticket_id").where("user_id", "=", userId).executeTakeFirst();
    if (left) return { ok: false, error: "has_tickets" };
  }
  await tx.deleteFrom("user_account").where("user_id", "=", userId).execute();
  await tx.deleteFrom("user_email").where("user_id", "=", userId).execute();
  // getDynamicData() crea un'entry vuota se manca, poi la elimina
  await userEntries(tx, userId);
  await deleteEntries(tx, "U", userId);
  await tx.deleteFrom("user").where("id", "=", userId).execute();
  await deleteSearchRow(tx, "U", userId);
  return { ok: true };
}

/* ------------------------------------------------------------------ import CSV */

class ImportFailure extends Error {}

/** fgetcsv($stream, n, ",", "\"", ""): una riga CSV (virgolette doppie, nessun carattere di escape). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  let any = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"') {
      quoted = true;
      any = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      any = true;
    } else if (c === "\n" || c === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      any = false;
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else {
      field += c;
      any = true;
    }
    i++;
  }
  if (any || field) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * User::importFromPost / importCsv (scp/users.php do=import-users, ajax.*:importUsers, scp/orgs.php):
 * intestazione "name, email" aggiunta al testo incollato, mappatura dei campi per nome o etichetta,
 * User::fromVars($data, true, true) per riga (utenti esistenti aggiornati con updateInfo). Tutto o niente.
 * Restituisce il numero di utenti importati o il messaggio d'errore (come il PHP).
 */
export async function importUsers(
  ctx: WriteContext,
  pasted: string,
  extra: { orgId?: number } = {},
  opts: { checkPerm?: boolean; file?: boolean } = {},
): Promise<{ ok: true; count: number } | { ok: false; error: DirError; detail?: string }> {
  const { agent } = ctx;
  if (opts.checkPerm !== false && (!agent || !agent.hasGlobalPerm(GlobalPerm.USER_CREATE))) return { ok: false, error: "forbidden" };
  // importFromPost: al testo incollato si antepone l'intestazione "name, email"; un file caricato la contiene già
  const stream = opts.file ? pasted : `name, email\n${pasted}`;
  // db_autocommit(false) … db_rollback(): savepoint dentro la transazione dell'operazione
  await sql`SAVEPOINT people_import`.execute(ctx.tx);
  try {
    const count = await doImport(ctx, stream, extra);
    await sql`RELEASE SAVEPOINT people_import`.execute(ctx.tx);
    return { ok: true, count };
  } catch (e) {
    if (e instanceof ImportFailure) {
      await sql`ROLLBACK TO SAVEPOINT people_import`.execute(ctx.tx);
      return { ok: false, error: "import", detail: e.message };
    }
    throw e;
  }
}

async function doImport(ctx: WriteContext, stream: string, extra: { orgId?: number }): Promise<number> {
  const { tx } = ctx;
  const form = await defaultFormOf(tx, "U");
  if (!form) throw new ImportFailure("Unable to parse submitted csv");
  const rows = parseCsv(stream);
  const named = form.fields.filter((f) => f.name);
  if (!rows.length) throw new ImportFailure("Whoops. Perhaps you meant to send some CSV records");
  const first = rows[0];
  let headers: FieldDef[] = [];
  let hasHeader = true;
  for (const raw of first) {
    const h = raw.trim().toLowerCase();
    const f = form.fields.find((x) => [x.name.toLowerCase(), x.label.toLowerCase()].includes(h));
    if (f) {
      if (!f.name) throw new ImportFailure(`${raw.trim()}: Field must have \`variable\` set to be imported`);
      headers.push(f);
      continue;
    }
    hasHeader = false;
    if (first.length === named.length) {
      headers = [...named];
      break;
    }
    throw new ImportFailure(`${raw.trim()}: Unable to map header to the object field`);
  }
  const data = hasHeader ? rows.slice(1) : rows;
  let imported = 0;
  for (const csv of data) {
    if (csv.length === 1 && csv[0] === "") continue;
    if (csv.length !== headers.length) throw new ImportFailure(`Bad data. Expected: ${headers.map((h) => h.label).join(", ")}`);
    const rec: Record<string, unknown> = {};
    if (extra.orgId !== undefined) rec.org_id = extra.orgId;
    headers.forEach((f, i) => {
      const v = parseInput(f, csv[i].trim());
      rec[f.name] = toDatabase(f, v);
    });
    const email = String(rec.email ?? "");
    if (!isEmail(email) || !rec.name) throw new ImportFailure("Both `name` and `email` fields are required");
    const existing = await lookupUserByEmail(tx, email);
    if (existing) {
      // fromVars($vars, true, $update=true) → updateInfo($vars, $errors, true): errori ignorati
      await updateUserInfo(ctx, existing.id, rec);
    } else {
      const u = await userFromVars(tx, rec, extra.orgId);
      if (!u) throw new ImportFailure(`Unable to import user: ${JSON.stringify(rec)}`);
    }
    imported++;
  }
  return imported;
}

/** Numero di ticket di un utente (User::tickets->count()) */
export async function userTicketCount(executor: DbOrTx, userId: number): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${table("ticket")} WHERE user_id = ${userId}`.execute(executor);
  return Number(rows[0]?.n ?? 0);
}
