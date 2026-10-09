import "server-only";

import { sql } from "kysely";

import type { DbOrTx } from "../../db";
import { phpJsonDecode, phpJsonEncode } from "../../format/php-json";
import { sanitizeText } from "../../format/text";
import { type MassResult, type SaveResult } from "./common";
import { OrmRow, SQL_NOW } from "./orm";
import { inArray, list, phpLooseEquals, str, truthy, type PhpVal, type PhpVars } from "./php";

/**
 * Ruoli: scp/roles.php → Role::update / Role::delete / mass_process (include/class.role.php) e
 * permessi JSON come RolePermission.
 */
export const RoleFlag = { ENABLED: 0x0001 } as const;

export interface PermissionDef {
  group: string;
  key: string;
  title: string;
  desc: string;
  /** permesso "primario" (globale dell'agente) invece che di ruolo */
  primary: boolean;
}

/**
 * RolePermission::allPermissions(): permessi registrati dalle classi osTicket, per gruppo e in ordine
 * alfabetico di titolo (asort; quelli con 'primary' dopo gli altri nello stesso gruppo).
 */
export const ALL_PERMISSIONS: PermissionDef[] = [
  ["Tickets", "ticket.assign", "Assign", "Ability to assign tickets to agents or teams", false],
  ["Tickets", "ticket.close", "Close", "Ability to close tickets", false],
  ["Tickets", "ticket.create", "Create", "Ability to open tickets on behalf of users", false],
  ["Tickets", "ticket.delete", "Delete", "Ability to delete tickets", false],
  ["Tickets", "ticket.edit", "Edit", "Ability to edit tickets", false],
  ["Tickets", "thread.edit", "Edit Thread", "Ability to edit thread items of other agents", false],
  ["Tickets", "ticket.link", "Link", "Ability to link tickets", false],
  ["Tickets", "ticket.markanswered", "Mark as Answered", "Ability to mark a ticket as Answered/Unanswered", false],
  ["Tickets", "ticket.merge", "Merge", "Ability to merge tickets", false],
  ["Tickets", "ticket.reply", "Post Reply", "Ability to post a ticket reply", false],
  ["Tickets", "ticket.refer", "Refer", "Ability to manage ticket referrals", false],
  ["Tickets", "ticket.release", "Release", "Ability to release ticket assignment", false],
  ["Tickets", "ticket.transfer", "Transfer", "Ability to transfer tickets between departments", false],
  ["Tasks", "task.assign", "Assign", "Ability to assign tasks to agents or teams", false],
  ["Tasks", "task.close", "Close", "Ability to close tasks", false],
  ["Tasks", "task.create", "Create", "Ability to create tasks", false],
  ["Tasks", "task.delete", "Delete", "Ability to delete tasks", false],
  ["Tasks", "task.edit", "Edit", "Ability to edit tasks", false],
  ["Tasks", "task.reply", "Post Reply", "Ability to post task update", false],
  ["Tasks", "task.transfer", "Transfer", "Ability to transfer tasks between departments", false],
  ["Users", "user.create", "Create", "Ability to add new users", true],
  ["Users", "user.delete", "Delete", "Ability to delete users", true],
  ["Users", "user.edit", "Edit", "Ability to manage user information", true],
  ["Users", "user.manage", "Manage Account", "Ability to manage active user accounts", true],
  ["Users", "user.dir", "User Directory", "Ability to access the user directory", true],
  ["Organizations", "org.create", "Create", "Ability to create new organizations", true],
  ["Organizations", "org.delete", "Delete", "Ability to delete organizations", true],
  ["Organizations", "org.edit", "Edit", "Ability to manage organizations", true],
  ["Knowledgebase", "canned.manage", "Premade", "Ability to add/update/disable/delete canned responses", false],
  ["Knowledgebase", "faq.manage", "FAQ", "Ability to add/update/disable/delete knowledgebase categories and FAQs", true],
  ["Miscellaneous", "visibility.agents", "Agent", "Ability to see Agents in all Departments", true],
  ["Miscellaneous", "emails.banlist", "Banlist", "Ability to add/remove emails from banlist via ticket interface", true],
  ["Miscellaneous", "visibility.departments", "Department", "Ability to see all Departments", true],
  ["Miscellaneous", "search.all", "Search", "See all tickets in search results, regardless of access", true],
  ["Miscellaneous", "stats.agents", "Stats", "Ability to view stats of other agents in allowed departments", true],
].map(([group, key, title, desc, primary]) => ({ group, key, title, desc, primary }) as PermissionDef);

/**
 * RolePermission su JSON: parte dai permessi salvati (ordine delle chiavi conservato), poi per ogni
 * permesso registrato imposta 1 se selezionato o lo rimuove; le chiavi nuove finiscono in coda.
 * JSON vuoto ([]) se non resta nulla, come json_encode di un array PHP vuoto.
 */
export function rebuildPermissions(current: string | null | undefined, selected: PhpVal): string {
  const perms = new Map<string, unknown>();
  const parsed = phpJsonDecode<unknown>(current ?? "", null);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) for (const [k, v] of Object.entries(parsed)) perms.set(k, v);
  else if (Array.isArray(parsed)) parsed.forEach((v, i) => perms.set(String(i), v));
  for (const p of ALL_PERMISSIONS) {
    if (inArray(p.key, selected)) perms.set(p.key, 1);
    else perms.delete(p.key);
  }
  if (!perms.size) return "[]";
  // array PHP con sole chiavi 0..n-1 in ordine → lista JSON
  const keys = [...perms.keys()];
  if (keys.every((k, i) => k === String(i))) return phpJsonEncode([...perms.values()]);
  return phpJsonEncode(Object.fromEntries(perms));
}

const ROLE_OPTS = { touchUpdated: true };

/** Role::update($vars, $errors) — creazione se roleId è null (Role::create()). */
export async function saveRole(executor: DbOrTx, roleId: number | null, vars: PhpVars): Promise<SaveResult> {
  const errors: Record<string, string> = {};
  let role: OrmRow;
  if (roleId) {
    const row = await OrmRow.load(executor, "role", "id", { id: roleId }, ROLE_OPTS);
    if (!row) return { ok: false, errors: { err: "not_found" } };
    role = row;
  } else {
    role = OrmRow.create("role", "id", ROLE_OPTS);
    role.set("created", SQL_NOW);
  }
  const name = sanitizeText(str(vars.name));
  if (!name) errors.name = "required";
  else {
    const r = await executor.selectFrom("role").select("id").where("name", "=", name).executeTakeFirst();
    if (r && !phpLooseEquals(r.id, vars.id as never)) errors.name = "exists";
    else if (!truthy(vars.perms) || !list(vars.perms).length) errors.err = "no_perms";
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  role.set("name", name);
  role.set("notes", sanitizeText(str(vars.notes)));
  role.set("permissions", rebuildPermissions(role.get("permissions") as string | null, vars.perms));
  // Role::save: le note modificate passano di nuovo da Format::sanitize (idempotente)
  await role.save(executor);
  return { ok: true, id: role.num("id"), errors: {} };
}

/** Role::isDeleteable(): nessun accesso esteso e nessun agente con il ruolo. */
export async function roleInUse(executor: DbOrTx, roleId: number): Promise<boolean> {
  const a = await executor.selectFrom("staff_dept_access").select("staff_id").where("role_id", "=", roleId).executeTakeFirst();
  const s = await executor.selectFrom("staff").select("staff_id").where("role_id", "=", roleId).executeTakeFirst();
  return !!(a || s);
}

export type RoleMassAction = "enable" | "disable" | "delete";

export async function massRoles(executor: DbOrTx, action: RoleMassAction, ids: number[]): Promise<MassResult> {
  if (!ids.length) return { ok: false, num: 0, error: "select" };
  switch (action) {
    case "enable":
    case "disable": {
      const expr = action === "enable" ? sql<number>`flags | ${RoleFlag.ENABLED}` : sql<number>`flags & ${~RoleFlag.ENABLED >>> 0}`;
      const res = await executor.updateTable("role").set({ flags: expr }).where("id", "in", ids).executeTakeFirst();
      const num = Number(res.numUpdatedRows);
      return { ok: num > 0, num };
    }
    case "delete": {
      let num = 0;
      for (const id of ids) {
        if (!(await executor.selectFrom("role").select("id").where("id", "=", id).executeTakeFirst())) continue;
        if (await roleInUse(executor, id)) continue;
        await executor.deleteFrom("role").where("id", "=", id).execute();
        // Role::delete: gli accessi estesi con il ruolo passano a role_id 0 (nessuno, dato il controllo)
        await executor.updateTable("staff_dept_access").set({ role_id: 0 }).where("role_id", "=", id).execute();
        num++;
      }
      return { ok: num > 0, num, error: num ? undefined : "in_use" };
    }
  }
}
