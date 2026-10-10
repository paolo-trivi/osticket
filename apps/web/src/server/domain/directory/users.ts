import "server-only";

import { sql } from "kysely";

import { UserModel } from "@/lib/osticket/flags";
import { FormType } from "@/lib/osticket/object-types";

import { NOW, type DbOrTx } from "../../db";
import { searchable } from "../../format/text";
import { phpLooseEquals, str, truthy } from "../../php/values";
import { deleteSearchRow, replaceSearchRow } from "../search/index-writer";
import { GlobalPerm } from "../staff/staff";
import { lookupUserByEmail, normalizeUserName, userFromVars } from "../ticket/create-user";
import type { WriteContext } from "../ticket/context";
import {
  addMissingAnswers,
  createEntry,
  defaultDates,
  defaultFormOf,
  deleteEntries,
  entriesFor,
  entriesSearchable,
  saveEntryAnswers,
  toDatabase,
  validateInput,
  type FormEntry,
} from "../forms/answers";
import { currentDates, FormInstance } from "../forms/entry";
import { hasAnswerRow, isEditableToStaff, isRequiredForStaff, isVisibleToStaff, parseField, parseFieldValue, type DateFormatOptions, type FieldDef } from "../forms/fields";
import { isEmail } from "../forms/validator";

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

interface UserCore {
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
export async function reindexUser(executor: DbOrTx, userId: number, emails?: string[], dates?: DateFormatOptions): Promise<void> {
  const u = await executor.selectFrom("user").select(["name"]).where("id", "=", userId).executeTakeFirst();
  if (!u) return;
  const entries = await entriesFor(executor, "U", userId);
  const content = entriesSearchable(entries, dates ?? (await defaultDates(executor)), ["subject"]).join("\n").trim();
  const list = emails ?? (await userEmails(executor, userId));
  await replaceSearchRow(executor, "U", userId, `${content} ${list.join("\n")}`, searchable(u.name));
}

/** Filtro di validazione di User::fromForm con un agente: obbligatorio o visibile all'agente. */
const staffFilter = (f: FieldDef) => isRequiredForStaff(f) || isVisibleToStaff(f);

/** Valore pulito (getClean) di un campo per nome, come testo. */
function cleanOf(fields: FieldDef[], input: Record<string, unknown>, name: string, timezone: string): string {
  const f = fields.find((x) => x.name === name);
  if (!f) return "";
  const v = parseField(f, input, timezone);
  if (v === null || v === false) return "";
  if (typeof v === "object") return Object.values(v).join(", ");
  return String(v);
}

/**
 * User::fromForm($form) da scp/users.php (do=create) e ajax.users.php:addUser: validazione dei campi
 * visibili/obbligatori per l'agente ed email non già assegnata.
 * Permessi: scp/users.php non controlla user.create (bug di permessi del PHP, non replicato).
 */
export async function createUser(ctx: WriteContext, input: Record<string, unknown>, opts: { checkPerm?: boolean } = {}): Promise<DirResult<{ id: number }>> {
  const { tx, agent } = ctx;
  if (opts.checkPerm !== false && (!agent || !agent.hasGlobalPerm(GlobalPerm.USER_CREATE))) return { ok: false, error: "forbidden" };
  const form = await defaultFormOf(tx, "U");
  if (!form) return { ok: false, error: "not_found" };
  const dates = await currentDates(ctx);
  const fields: Record<string, string> = await validateInput(form.fields, input, staffFilter, ctx.cfg, dates);
  const email = cleanOf(form.fields, input, "email", dates.timezone);
  if (email && (await lookupUserByEmail(tx, email))) fields.email = "in_use";
  if (Object.keys(fields).length) return { ok: false, error: "invalid", fields };
  // User::fromVars($form->getClean())
  const inst = new FormInstance({ id: form.id, type: FormType.USER, title: "", instructions: "", fields: form.fields }, input, 1, null, { dates });
  const user = await userFromVars(tx, ctx.cfg, inst.cleanVars(), { dates });
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
  dates?: DateFormatOptions,
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (changes.name !== undefined && !phpLooseEquals(user.name, changes.name)) set.name = normalizeUserName(changes.name);
  if (changes.org_id !== undefined && !phpLooseEquals(user.org_id, changes.org_id)) set.org_id = changes.org_id;
  if (changes.status !== undefined && !phpLooseEquals(user.status, changes.status)) set.status = changes.status;
  if (!Object.keys(set).length && !touch) return;
  set.updated = NOW;
  await executor.updateTable("user").set(set as never).where("id", "=", user.id).execute();
  Object.assign(user, set);
  await reindexUser(executor, user.id, cachedEmails, dates);
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
  const dates = await currentDates(ctx);
  const { timezone } = dates;
  // User::getForms: addMissingFields prima della validazione
  for (const e of entries) await addMissingAnswers(tx, e, userId);
  const fields: Record<string, string> = {};
  for (const e of entries) {
    Object.assign(fields, await validateInput(e.fields, input, isEditableToStaff, ctx.cfg, { timezone }));
    if (e.form_type === FormType.USER) {
      const f = e.fields.find((x) => x.name === "email");
      if (f && isEditableToStaff(f)) {
        const email = cleanOf(e.fields, input, "email", timezone);
        const other = email ? await lookupUserByEmail(tx, email) : null;
        if (other && other.id !== userId) fields.email = "in_use";
      }
    }
  }
  if (Object.keys(fields).length) return { ok: false, error: "invalid", fields };

  let name: string | undefined;
  let touch = false;
  for (const e of entries) {
    if (e.form_type === FormType.USER) {
      const nf = e.fields.find((x) => x.name === "name");
      if (nf && isEditableToStaff(nf)) name = cleanOf(e.fields, input, "name", timezone).trim();
      const ef = e.fields.find((x) => x.name === "email");
      if (ef && isEditableToStaff(ef)) {
        const email = cleanOf(e.fields, input, "email", timezone);
        const cur = await tx.selectFrom("user_email").select(["id", "address"]).where("id", "=", user.default_email_id).executeTakeFirst();
        if (cur && !phpLooseEquals(cur.address, email)) {
          await tx.updateTable("user_email").set({ address: email }).where("id", "=", cur.id).execute();
        }
      }
    }
    // Widget::getValue: i campi assenti dalla sorgente mantengono il valore attuale
    const r = await saveEntryAnswers(tx, e, userId, input, { isEditable: (f) => isEditableToStaff(f) && hasAnswerRow(f), onlyProvided: true, timezone });
    if (r.dirty) touch = true;
  }
  await saveUser(tx, user, name !== undefined ? { name } : {}, touch, undefined, dates);
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
  await saveUser(ctx.tx, user, { org_id: 0, status: user.status & ~UserModel.PRIMARY_ORG_CONTACT });
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
    // CsvImportIterator: $f->parse(trim($csv[$i])) (senza widget), poi to_database
    headers.forEach((f, i) => {
      rec[f.name] = toDatabase(f, parseFieldValue(f, csv[i].trim()));
    });
    const email = str(rec.email as string | null);
    if (!isEmail(email) || !truthy(rec.name as string | null)) throw new ImportFailure("Both `name` and `email` fields are required");
    const existing = await lookupUserByEmail(tx, email);
    if (existing) {
      // fromVars($vars, true, $update=true) → updateInfo($vars, $errors, true): errori ignorati
      await updateUserInfo(ctx, existing.id, rec);
    } else {
      const u = await userFromVars(tx, ctx.cfg, rec, { dates: await currentDates(ctx) });
      if (!u) throw new ImportFailure(`Unable to import user: ${JSON.stringify(rec)}`);
    }
    imported++;
  }
  return imported;
}

