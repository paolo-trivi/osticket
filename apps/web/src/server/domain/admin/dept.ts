import "server-only";

import { sql } from "kysely";

import { Dept, StaffDeptAccess } from "@/lib/osticket/flags";

import type { DbOrTx } from "../../db";
import { stripTags } from "../../format/html";
import { sanitizeText } from "../../format/text";
import { at, intval, isset, list, phpLooseEquals, str, truthy, type PhpVal, type PhpVars } from "../../php/values";
import { adminDefaults, exists, idOf, type MassResult, type SaveResult } from "./common";
import { FILTER_REFS, filterActionsReferencing } from "./filters";
import { OrmRow, SQL_NOW, setFlag } from "./orm";

/**
 * Reparti: scp/departments.php → Dept::update / Dept::create / Dept::delete / mass_process
 * (include/class.dept.php). Accessi estesi degli agenti in staff_dept_access (Dept::updateAccess),
 * ruolo dei membri primari salvato sulla riga staff (members->saveAll → Staff::save, updated=NOW).
 */

const DEPT_OPTS = { touchUpdated: true };
const STAFF_OPTS = { touchUpdated: true };

async function loadDeptRow(executor: DbOrTx, id: number): Promise<OrmRow | null> {
  return OrmRow.load(executor, "department", "id", { id }, DEPT_OPTS);
}

/** Dept::getFullPath(): percorso degli id antenati ("/1/4/"), calcolato risalendo i pid. */
async function deptFullPath(executor: DbOrTx, pid: unknown, selfId: number | null): Promise<string> {
  let path = "/";
  const parentId = idOf(pid as PhpVal);
  if (parentId) {
    const p = await executor.selectFrom("department").select(["id", "pid"]).where("id", "=", parentId).executeTakeFirst();
    if (p) path = await deptFullPath(executor, p.pid, p.id);
  }
  return `${path}${selfId ?? ""}/`;
}

/** Dept::getIdByName($name, $pid): stesso nome con lo stesso padre (NULL se pid vuoto). */
async function deptIdByName(executor: DbOrTx, name: string, pid: PhpVal): Promise<number> {
  let q = executor.selectFrom("department").select("id").where("name", "=", name);
  q = truthy(pid) ? q.where(sql<boolean>`pid = ${str(pid)}`) : q.where("pid", "is", null);
  return (await q.executeTakeFirst())?.id ?? 0;
}

/** StaffDeptAccess::setAlerts: flags |= / &= ~FLAG_ALERTS (sulle righe nuove 0 non è "dirty"). */
function setAlerts(row: OrmRow, alerts: PhpVal): void {
  setFlag(row, StaffDeptAccess.ALERTS, truthy(alerts));
}

/**
 * Dept::updateAccess($access, $errors): accessi estesi (righe nuove/ruolo/avvisi), rimozione degli
 * accessi non più elencati, ruolo dei membri primari.
 */
async function updateAccess(
  executor: DbOrTx,
  deptId: number | null,
  access: [PhpVal, PhpVal, PhpVal][],
  errors: Record<string, string>,
  extended: OrmRow[],
): Promise<{ ok: boolean; extended: OrmRow[] }> {
  const dropped = new Set(extended.map((r) => r.num("staff_id")));
  const members = deptId
    ? (await executor.selectFrom("staff").selectAll().where("dept_id", "=", deptId).execute()).map((r) => OrmRow.from("staff", "staff_id", r, STAFF_OPTS))
    : [];
  const memberErrors: Record<string, string> = {};
  for (const [staffIdRaw, roleId, alerts] of access) {
    const sid = idOf(staffIdRaw);
    if (sid) dropped.delete(sid);
    else dropped.delete(intval(staffIdRaw));
    if (!truthy(roleId) || !(await exists(executor, "role", roleId))) memberErrors[str(staffIdRaw)] = "role";
    const staff = truthy(staffIdRaw) && sid ? await executor.selectFrom("staff").select(["staff_id", "dept_id"]).where("staff_id", "=", sid).executeTakeFirst() : undefined;
    if (!staff) memberErrors[str(staffIdRaw)] = "agent";
    if (phpLooseEquals(staff?.dept_id ?? null, deptId)) {
      // membro primario: si aggiorna solo il ruolo
      const m = members.find((r) => phpLooseEquals(r.get("staff_id"), staffIdRaw as never));
      if (m) m.set("role_id", str(roleId));
      continue;
    }
    let da = extended.find((r) => phpLooseEquals(r.get("staff_id"), staffIdRaw as never));
    if (!da) {
      da = OrmRow.create("staff_dept_access", ["staff_id", "dept_id"]);
      da.set("staff_id", str(staffIdRaw));
      da.set("role_id", str(roleId));
      // InstrumentedList::add collega il reparto: per un reparto nuovo la chiave si risolve al save()
      if (deptId) da.set("dept_id", deptId);
      extended.push(da);
    } else {
      da.set("role_id", str(roleId));
    }
    setAlerts(da, alerts);
  }
  if (Object.keys(memberErrors).length) errors.members = JSON.stringify(memberErrors);
  if (Object.keys(errors).length) return { ok: false, extended };

  if (dropped.size) {
    for (const r of extended) await r.save(executor);
    if (deptId) await executor.deleteFrom("staff_dept_access").where("dept_id", "=", deptId).where("staff_id", "in", [...dropped]).execute();
    // reset(): la lista viene riletta dal DB
    extended = deptId ? await loadExtended(executor, deptId) : [];
  }
  for (const m of members) await m.save(executor);
  return { ok: true, extended };
}

async function loadExtended(executor: DbOrTx, deptId: number): Promise<OrmRow[]> {
  const rows = await executor.selectFrom("staff_dept_access").selectAll().where("dept_id", "=", deptId).execute();
  return rows.map((r) => OrmRow.from("staff_dept_access", ["staff_id", "dept_id"], r));
}

/** Dept::update($vars, $errors) — creazione se deptId è null (Dept::create()). */
export async function saveDept(executor: DbOrTx, deptId: number | null, vars: PhpVars): Promise<SaveResult> {
  const errors: Record<string, string> = {};
  const defaults = await adminDefaults(executor);
  let dept: OrmRow;
  if (deptId) {
    const row = await loadDeptRow(executor, deptId);
    if (!row) return { ok: false, errors: { err: "not_found" } };
    dept = row;
  } else {
    dept = OrmRow.create("department", "id", DEPT_OPTS);
    dept.set("created", SQL_NOW);
  }
  const id = deptId;

  if (id && !phpLooseEquals(id, vars.id as never)) errors.err = "internal";
  if (!truthy(vars.name)) errors.name = "required";
  else {
    const did = await deptIdByName(executor, str(vars.name), vars.pid);
    if (did && did !== id) errors.name = "exists";
  }
  if (!truthy(vars.ispublic) && phpLooseEquals(vars.id as never, defaults.deptId)) errors.ispublic = "default_private";
  if (truthy(vars.pid) && !(await exists(executor, "department", vars.pid))) errors.pid = "required";
  const parentId = idOf(vars.pid);
  const parent = parentId ? await executor.selectFrom("department").select(["id", "pid", "flags"]).where("id", "=", parentId).executeTakeFirst() : undefined;
  if (parent) {
    if (!((parent.flags ?? 0) & Dept.ACTIVE)) errors.dept_id = "parent_inactive";
    else if ((await deptFullPath(executor, parent.pid, parent.id)).includes(`/${id ?? ""}/`)) errors.pid = "parent_loop";
  }
  if (truthy(vars.sla_id) && !(await exists(executor, "sla", vars.sla_id))) errors.sla_id = "invalid";
  if (truthy(vars.manager_id) && !(await exists(executor, "staff", vars.manager_id))) errors.manager_id = "invalid";
  if (truthy(vars.email_id) && !(await exists(executor, "email", vars.email_id))) errors.email_id = "invalid";
  if (truthy(vars.tpl_id) && !(await exists(executor, "email_template_group", vars.tpl_id))) errors.tpl_id = "invalid";
  if (truthy(vars.autoresp_email_id) && !(await exists(executor, "email", vars.autoresp_email_id))) errors.autoresp_email_id = "invalid";

  const access: [PhpVal, PhpVal, PhpVal][] = [];
  if (isset(vars, "members")) for (const sid of list(vars.members)) access.push([sid, at(vars.member_role, str(sid)), at(vars.member_alerts, str(sid))]);
  let extended = id ? await loadExtended(executor, id) : [];
  const acc = await updateAccess(executor, id, access, errors, extended);
  extended = acc.extended;
  if (Object.keys(errors).length) return { ok: false, errors };

  // disable_auto_claim: 1 se presente, poi rimosso se diverso da 1 (cioè mai rimosso se presente)
  const disableAutoClaim = isset(vars, "disable_auto_claim");

  dept.set("pid", truthy(vars.pid) ? str(vars.pid) : null);
  dept.set("ispublic", isset(vars, "ispublic") ? intval(vars.ispublic) : 0);
  dept.set("email_id", isset(vars, "email_id") ? intval(vars.email_id) : 0);
  dept.set("tpl_id", isset(vars, "tpl_id") ? intval(vars.tpl_id) : 0);
  dept.set("sla_id", isset(vars, "sla_id") ? intval(vars.sla_id) : 0);
  dept.set("schedule_id", isset(vars, "schedule_id") ? intval(vars.schedule_id) : 0);
  dept.set("autoresp_email_id", isset(vars, "autoresp_email_id") ? intval(vars.autoresp_email_id) : 0);
  dept.set("manager_id", truthy(vars.manager_id) ? str(vars.manager_id) : 0);
  dept.set("name", stripTags(str(vars.name)));
  dept.set("signature", sanitizeText(str(vars.signature)));
  dept.set("group_membership", vars.group_membership === undefined ? null : str(vars.group_membership));
  dept.set("ticket_auto_response", isset(vars, "ticket_auto_response") ? str(vars.ticket_auto_response) : 1);
  dept.set("message_auto_response", isset(vars, "message_auto_response") ? str(vars.message_auto_response) : 1);
  // $this->flags = $vars['flags'] ?: 0 → i flag si ricostruiscono (e la colonna risulta sempre modificata)
  dept.set("flags", truthy(vars.flags) ? intval(vars.flags) : 0);
  setFlag(dept, Dept.ASSIGN_MEMBERS_ONLY, isset(vars, "assign_members_only"));
  setFlag(dept, Dept.DISABLE_AUTO_CLAIM, disableAutoClaim);
  setFlag(dept, Dept.DISABLE_REOPEN_AUTO_ASSIGN, isset(vars, "disable_reopen_auto_assign"));
  // FilterAction::setFilterFlags(FLAG_INACTIVE_DEPT): nessuna scrittura (vedi filters.ts)

  let status = str(vars.status);
  if (id && id === defaults.deptId) status = "active";
  switch (status) {
    case "active":
      setFlag(dept, Dept.ACTIVE, true);
      setFlag(dept, Dept.ARCHIVED, false);
      break;
    case "disabled":
      setFlag(dept, Dept.ACTIVE, false);
      setFlag(dept, Dept.ARCHIVED, false);
      break;
    case "archived":
      setFlag(dept, Dept.ACTIVE, false);
      setFlag(dept, Dept.ARCHIVED, true);
      break;
  }
  switch (str(vars.assignment_flag)) {
    case "all":
      setFlag(dept, Dept.ASSIGN_MEMBERS_ONLY, false);
      setFlag(dept, Dept.ASSIGN_PRIMARY_ONLY, false);
      break;
    case "members":
      setFlag(dept, Dept.ASSIGN_MEMBERS_ONLY, true);
      setFlag(dept, Dept.ASSIGN_PRIMARY_ONLY, false);
      break;
    case "primary":
      setFlag(dept, Dept.ASSIGN_MEMBERS_ONLY, false);
      setFlag(dept, Dept.ASSIGN_PRIMARY_ONLY, true);
      break;
  }
  dept.set("path", await deptFullPath(executor, dept.get("pid"), id));

  const wasNew = dept.isNew;
  await dept.save(executor);
  const newId = dept.num("id");
  for (const r of extended) {
    if (r.isNew && !r.get("dept_id")) r.set("dept_id", newId);
    await r.save(executor);
  }
  if (wasNew) {
    dept.set("path", await deptFullPath(executor, dept.get("pid"), newId));
    await dept.save(executor);
  }
  return { ok: true, id: newId, errors: {} };
}

/**
 * Dept::delete(): non si elimina il reparto predefinito né uno con membri primari; poi ticket, task
 * e agenti passano al reparto predefinito, help topic ed email perdono il reparto, si eliminano gli
 * accessi estesi. Restituisce false se l'eliminazione è rifiutata.
 */
async function deleteDept(executor: DbOrTx, deptId: number): Promise<{ ok: boolean; error?: string }> {
  const { deptId: def } = await adminDefaults(executor);
  if (deptId === def) return { ok: false, error: "default" };
  const members = await executor.selectFrom("staff").select("staff_id").where("dept_id", "=", deptId).execute();
  if (members.length) return { ok: false, error: "has_members" };
  if (await filterActionsReferencing(executor, FILTER_REFS.dept, deptId)) return { ok: false, error: "filter" };
  const res = await executor.deleteFrom("department").where("id", "=", deptId).executeTakeFirst();
  if (!Number(res.numDeletedRows)) return { ok: true };
  await executor.updateTable("ticket").set({ dept_id: def }).where("dept_id", "=", deptId).execute();
  await executor.updateTable("task").set({ dept_id: def }).where("dept_id", "=", deptId).execute();
  await executor.updateTable("staff").set({ dept_id: def }).where("dept_id", "=", deptId).execute();
  await executor.updateTable("help_topic").set({ dept_id: 0 }).where("dept_id", "=", deptId).execute();
  await executor.updateTable("email").set({ dept_id: 0 }).where("dept_id", "=", deptId).execute();
  await executor.deleteFrom("staff_dept_access").where("dept_id", "=", deptId).execute();
  return { ok: true };
}

export type DeptMassAction = "make_public" | "make_private" | "enable" | "disable" | "archive" | "delete";

/** scp/departments.php mass_process */
export async function massDept(executor: DbOrTx, action: DeptMassAction, ids: number[]): Promise<MassResult> {
  if (!ids.length) return { ok: false, num: 0, error: "select" };
  const { deptId: def } = await adminDefaults(executor);
  if (ids.includes(def)) return { ok: false, num: 0, error: "default" };
  let num = 0;
  switch (action) {
    case "make_public":
    case "make_private":
      // La query del PHP usa la colonna inesistente "dept_id" (la colonna è "id"): fallisce sempre e
      // non modifica nulla. Bug replicato: nessuna scrittura, errore all'utente.
      return { ok: false, num: 0, error: "failed" };
    case "enable":
    case "disable":
    case "archive": {
      const rows = await executor.selectFrom("department").selectAll().where("id", "in", ids).where("id", "!=", def).execute();
      for (const r of rows) {
        const d = OrmRow.from("department", "id", r, DEPT_OPTS);
        setFlag(d, Dept.ARCHIVED, action === "archive");
        setFlag(d, Dept.ACTIVE, action === "enable");
        await d.save(executor);
        num++;
      }
      return { ok: num > 0, num };
    }
    case "delete": {
      const m = await executor.selectFrom("staff").select("staff_id").where("dept_id", "in", ids).execute();
      if (m.length) return { ok: false, num: 0, error: "has_members" };
      for (const id of ids) {
        if (id === def) continue;
        if (!(await executor.selectFrom("department").select("id").where("id", "=", id).executeTakeFirst())) continue;
        const r = await deleteDept(executor, id);
        if (r.error === "filter") return { ok: num > 0, num, error: "filter" };
        num++;
      }
      return { ok: num > 0, num };
    }
  }
}
