import "server-only";

import { sql } from "kysely";

import { NOW, type DbOrTx } from "../../db";
import { stripTags } from "../../format/html";
import { searchable } from "../../format/text";
import { deleteSearchRow, replaceSearchRow } from "../search/index-writer";
import { GlobalPerm } from "../staff/staff";
import type { WriteContext } from "../ticket/context";
import { phpLooseEquals } from "../ticket/record";
import {
  createEntry,
  defaultFormOf,
  deleteEntries,
  entriesFor,
  hasAnswerRow,
  inputFor,
  isEmail,
  parseInput,
  saveEntryAnswers,
  validateInput,
  answerSearchable,
  type FormEntry,
} from "./forms";
import { createUser, loadUserCore, reindexUser, removeUserFromOrg, setUserOrganization, UserStatus, type DirResult } from "./users";

/**
 * Organizzazioni (include/class.organization.php, include/ajax.orgs.php, scp/orgs.php): righe
 * organization, form_entry(_values), organization__cdata, _search; stato e membri.
 */
export const OrgFlag = {
  COLLAB_ALL_MEMBERS: 0x0001,
  COLLAB_PRIMARY_CONTACT: 0x0002,
  ASSIGN_AGENT_MANAGER: 0x0004,
  SHARE_PRIMARY_CONTACT: 0x0008,
  SHARE_EVERYBODY: 0x0010,
} as const;

export interface OrgCore {
  id: number;
  name: string;
  manager: string;
  status: number;
  domain: string;
}

export async function loadOrgCore(executor: DbOrTx, id: number, forUpdate = false): Promise<OrgCore | null> {
  let q = executor.selectFrom("organization").select(["id", "name", "manager", "status", "domain"]).where("id", "=", id);
  if (forUpdate) q = q.forUpdate();
  const r = await q.executeTakeFirst();
  return r ? { id: r.id, name: r.name, manager: r.manager ?? "", status: r.status, domain: r.domain ?? "" } : null;
}

/** SearchBackend::updateModel(Organization): tutte le risposte indicizzabili, titolo = nome. */
async function reindexOrg(executor: DbOrTx, orgId: number, entries?: FormEntry[]): Promise<void> {
  const o = await executor.selectFrom("organization").select("name").where("id", "=", orgId).executeTakeFirst();
  if (!o) return;
  const list = entries ?? (await entriesFor(executor, "O", orgId));
  const content: string[] = [];
  for (const e of list) {
    for (const f of e.fields) {
      const a = e.answers.get(f.id);
      if (!a?.exists) continue;
      const s = answerSearchable(f, a.value);
      if (s) content.push(s);
    }
  }
  await replaceSearchRow(executor, "O", orgId, content.join("\n").trim(), searchable(o.name));
}

function nameOf(fields: { name: string }[], input: Record<string, unknown>): string {
  const f = (fields as Parameters<typeof inputFor>[1][]).find((x) => x.name === "name");
  if (!f) return "";
  const v = parseInput(f, inputFor(input, f));
  return typeof v === "string" ? v : "";
}

/** Organization::fromForm + fromVars (ajax.orgs.php:addOrg, ajax.users.php:updateOrg con nuova org) */
export async function createOrg(ctx: WriteContext, input: Record<string, unknown>): Promise<DirResult<{ id: number }>> {
  const { tx, agent } = ctx;
  if (!agent || !agent.hasGlobalPerm(GlobalPerm.ORG_CREATE)) return { ok: false, error: "forbidden" };
  const form = await defaultFormOf(tx, "O");
  if (!form) return { ok: false, error: "not_found" };
  const fields = validateInput(form.fields, input, () => true);
  const clean = nameOf(form.fields, input);
  if (clean && (await tx.selectFrom("organization").select("id").where("name", "=", clean).executeTakeFirst())) fields.name = "in_use";
  if (Object.keys(fields).length) return { ok: false, error: "invalid", fields };
  // fromVars: Format::striptags del nome pulito
  const name = stripTags(clean);
  let org = await tx.selectFrom("organization").select("id").where("name", "=", name).executeTakeFirst();
  if (!org) {
    const r = await tx
      .insertInto("organization")
      .values({ name, status: OrgFlag.SHARE_PRIMARY_CONTACT, created: NOW, updated: NOW })
      .executeTakeFirstOrThrow();
    org = { id: Number(r.insertId) };
    await createEntry(tx, form, "O", "O", org.id, input);
  }
  // organization.created
  await reindexOrg(tx, org.id);
  return { ok: true, id: org.id };
}

/** Variabili del profilo dell'organizzazione (ajax.orgs.php:updateOrg con profile). */
export interface OrgProfileVars {
  domain?: string;
  /** "s<id>" agente, "t<id>" team, vuoto = nessuno */
  manager?: string;
  "collab-all-flag"?: boolean;
  "collab-pc-flag"?: boolean;
  "assign-am-flag"?: boolean;
  /** "sharing-primary" | "sharing-all" | "" */
  sharing?: string;
  /** id dei contatti principali; assente = nessuno */
  contacts?: (number | string)[];
}

interface UpdateState {
  org: OrgCore;
  status: number;
  answersSaved: boolean;
  entries: FormEntry[];
}

/**
 * Organization::update($vars): validazione (nome obbligatorio e univoco), salvataggio del nome (con
 * reindicizzazione immediata, prima delle risposte: stranezza replicata), risposte dei campi forniti,
 * contatti principali. Flag, dominio e manager restano in memoria (li salva solo updateProfile).
 * Stranezza replicata: senza `contacts` il PHP toglie a tutti i membri il flag di contatto principale.
 */
async function orgUpdate(
  ctx: WriteContext,
  orgId: number,
  input: Record<string, unknown>,
  vars: OrgProfileVars,
  validateOnly = false,
): Promise<DirResult<{ state: UpdateState }>> {
  const { tx } = ctx;
  const org = await loadOrgCore(tx, orgId, true);
  if (!org) return { ok: false, error: "not_found" };
  let entries = await entriesFor(tx, "O", orgId);
  if (!entries.length) {
    const form = await defaultFormOf(tx, "O");
    if (form) {
      await createEntry(tx, form, "O", "O", orgId, {});
      entries = await entriesFor(tx, "O", orgId);
    }
  }
  const fields: Record<string, string> = {};
  for (const e of entries) {
    Object.assign(fields, validateInput(e.fields, input, () => true));
    if (e.form_type === "O") {
      const clean = nameOf(e.fields, input);
      if (clean) {
        const other = await tx.selectFrom("organization").select("id").where("name", "=", clean).executeTakeFirst();
        if (other && other.id !== orgId) fields.name = "in_use";
      }
    }
  }
  if (Object.keys(fields).length) return { ok: false, error: "invalid", fields };
  if (validateOnly) return { ok: true, state: { org, status: org.status, answersSaved: false, entries } };

  let answersSaved = false;
  for (const e of entries) {
    if (e.form_type === "O" && e.fields.some((f) => f.name === "name")) {
      const name = nameOf(e.fields, input);
      if (!phpLooseEquals(org.name, name)) {
        await tx.updateTable("organization").set({ name }).where("id", "=", orgId).execute();
        org.name = name;
        await reindexOrg(tx, orgId);
      }
    }
    const r = await saveEntryAnswers(tx, e, orgId, input, { isEditable: hasAnswerRow, onlyProvided: true });
    if (r.dirty) answersSaved = true;
  }

  let status = org.status;
  const flags: [keyof OrgProfileVars, number][] = [
    ["collab-all-flag", OrgFlag.COLLAB_ALL_MEMBERS],
    ["collab-pc-flag", OrgFlag.COLLAB_PRIMARY_CONTACT],
    ["assign-am-flag", OrgFlag.ASSIGN_AGENT_MANAGER],
  ];
  for (const [k, flag] of flags) status = vars[k] ? status | flag : status & ~flag;
  for (const [k, flag] of [["sharing-primary", OrgFlag.SHARE_PRIMARY_CONTACT], ["sharing-all", OrgFlag.SHARE_EVERYBODY]] as const) {
    status = vars.sharing === k ? status | flag : status & ~flag;
  }

  const members = await tx.selectFrom("user").select(["id", "status"]).where("org_id", "=", orgId).orderBy("id").execute();
  if (vars.contacts && vars.contacts.length) {
    const ids = vars.contacts.map((c) => String(c));
    for (const m of members) {
      const want = ids.includes(String(m.id));
      const next = want ? m.status | UserStatus.PRIMARY_ORG_CONTACT : m.status & ~UserStatus.PRIMARY_ORG_CONTACT;
      if (next !== m.status) {
        await tx.updateTable("user").set({ status: next, updated: NOW }).where("id", "=", m.id).execute();
        await reindexUser(tx, m.id);
      }
    }
  } else if (members.length) {
    // QuerySet::update senza updated né reindicizzazione
    await tx.updateTable("user").set({ status: sql<number>`status & ${~UserStatus.PRIMARY_ORG_CONTACT}` }).where("org_id", "=", orgId).execute();
  }
  return { ok: true, state: { org, status, answersSaved, entries } };
}

/** Campi del form dell'organizzazione (ajax.orgs.php:updateOrg). */
export async function updateOrg(ctx: WriteContext, orgId: number, input: Record<string, unknown>): Promise<DirResult> {
  if (!ctx.agent || !ctx.agent.hasGlobalPerm(GlobalPerm.ORG_EDIT)) return { ok: false, error: "forbidden" };
  const r = await orgUpdate(ctx, orgId, input, {});
  return r.ok ? { ok: true } : r;
}

/** Organization::updateProfile($vars): dominio, manager, flag di collaborazione/condivisione, contatti. */
export async function updateOrgProfile(ctx: WriteContext, orgId: number, input: Record<string, unknown>, vars: OrgProfileVars): Promise<DirResult> {
  const { tx, agent } = ctx;
  if (!agent || !agent.hasGlobalPerm(GlobalPerm.ORG_EDIT)) return { ok: false, error: "forbidden" };
  const fields: Record<string, string> = {};
  if (vars.domain) {
    for (const d of vars.domain.split(",")) if (!isEmail(`t@${d.trim()}`)) fields.domain = "invalid";
  }
  if (vars.manager) {
    const kind = vars.manager[0];
    const id = Number(vars.manager.slice(1)) || 0;
    let found = false;
    if (kind === "s") found = !!(await tx.selectFrom("staff").select("staff_id").where("staff_id", "=", id).executeTakeFirst());
    else if (kind === "t") found = !!(await tx.selectFrom("team").select("team_id").where("team_id", "=", id).executeTakeFirst());
    if (!found) fields.manager = "invalid";
  }
  // Il PHP valida i dati del form anche in presenza di errori (senza salvarli)
  if (Object.keys(fields).length) {
    const probe = await orgUpdate(ctx, orgId, input, vars, true);
    return { ok: false, error: "invalid", fields: { ...fields, ...(probe.ok ? {} : probe.fields) } };
  }
  const r = await orgUpdate(ctx, orgId, input, vars);
  if (!r.ok) return r;
  const { org, status } = r.state;
  const set: Record<string, unknown> = {};
  if (!phpLooseEquals(org.status, status)) set.status = status;
  if (!phpLooseEquals(org.domain, vars.domain ?? "")) set.domain = vars.domain ?? "";
  if (!phpLooseEquals(org.manager, vars.manager || "")) set.manager = vars.manager || "";
  if (r.state.answersSaved) set.updated = NOW;
  if (Object.keys(set).length) {
    await tx.updateTable("organization").set(set as never).where("id", "=", orgId).execute();
    await reindexOrg(tx, orgId);
  }
  return { ok: true };
}

/** Organization::delete(): organizzazione, indice, membri scollegati (senza updated), entry dei form. */
export async function deleteOrg(ctx: WriteContext, orgId: number): Promise<DirResult> {
  const { tx, agent } = ctx;
  if (!agent || !agent.hasGlobalPerm(GlobalPerm.ORG_DELETE)) return { ok: false, error: "forbidden" };
  const org = await loadOrgCore(tx, orgId, true);
  if (!org) return { ok: false, error: "not_found" };
  await tx.deleteFrom("organization").where("id", "=", orgId).execute();
  await deleteSearchRow(tx, "O", orgId);
  await tx.updateTable("user").set({ org_id: 0 }).where("org_id", "=", orgId).execute();
  await deleteEntries(tx, "O", orgId);
  return { ok: true };
}

/** scp/orgs.php a=mass_process do=delete. Permessi: il PHP non li controlla (non replicato: org.delete). */
export async function massDeleteOrgs(ctx: WriteContext, ids: number[]): Promise<{ ok: boolean; count: number }> {
  if (!ctx.agent || !ctx.agent.hasGlobalPerm(GlobalPerm.ORG_DELETE)) return { ok: false, count: 0 };
  const rows = ids.length ? await ctx.tx.selectFrom("organization").select("id").where("id", "in", ids).orderBy("id").execute() : [];
  let count = 0;
  for (const { id } of rows) if ((await deleteOrg(ctx, id)).ok) count++;
  return { ok: count > 0, count };
}

/**
 * scp/orgs.php a=remove-users: Organization::removeUser per ogni utente (il PHP non verifica che
 * l'utente appartenga all'organizzazione: stranezza replicata). Permessi: il PHP non li controlla;
 * qui serve user.edit (regola più stretta, annotata).
 */
export async function removeOrgUsers(ctx: WriteContext, orgId: number, userIds: number[]): Promise<{ ok: boolean; count: number }> {
  if (!ctx.agent || !ctx.agent.hasGlobalPerm(GlobalPerm.USER_EDIT)) return { ok: false, count: 0 };
  if (!(await loadOrgCore(ctx.tx, orgId))) return { ok: false, count: 0 };
  let count = 0;
  for (const id of userIds) if (await removeUserFromOrg(ctx, id)) count++;
  return { ok: count > 0, count };
}

/** ajax.orgs.php:addUser: utente esistente (non già membro) o nuovo utente dal form. */
export async function addOrgUser(ctx: WriteContext, orgId: number, opts: { userId?: number; fields?: Record<string, unknown> }): Promise<DirResult<{ id: number }>> {
  const { tx, agent } = ctx;
  if (!agent || !agent.hasGlobalPerm(GlobalPerm.USER_EDIT)) return { ok: false, error: "forbidden" };
  const org = await loadOrgCore(tx, orgId);
  if (!org) return { ok: false, error: "not_found" };
  let userId: number;
  let created = false;
  if (opts.userId) {
    const u = await loadUserCore(tx, opts.userId);
    if (!u) return { ok: false, error: "not_found" };
    if (u.org_id === orgId) return { ok: false, error: "invalid", fields: { id: "already_member" } };
    userId = u.id;
  } else {
    // User::fromForm($form, $can_create): senza user.create l'utente non viene creato
    const r = await createUser(ctx, opts.fields ?? {}, { checkPerm: true });
    if (!r.ok) return r;
    userId = r.id;
    created = true;
  }
  const r = await setUserOrganization(ctx, userId, orgId, false, created);
  return r.ok ? { ok: true, id: userId } : r;
}

export { reindexOrg };
