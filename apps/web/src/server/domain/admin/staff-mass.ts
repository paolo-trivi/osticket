import "server-only";

import type { DbOrTx } from "../../db";
import { truthy, type PhpVars } from "../../php/values";
import { exists, idOf, type MassResult } from "./common";
import { FILTER_REFS, filterActionsReferencing } from "./filters";
import { OrmRow } from "./orm";
import { loadAccess, setDepartmentId, staffPermissions, STAFF_OPTS } from "./staff-row";

/** Eliminazione e azioni di massa sugli agenti: Staff::delete e scp/staff.php mass_process. */

/**
 * Staff::delete(): non se stessi; ticket non più assegnati, voci del thread con il nome dell'agente
 * come poster, iscrizioni ai team e accessi estesi eliminati. I task assegnati restano (come nel PHP).
 */
async function deleteStaff(executor: DbOrTx, staffId: number, actorId: number): Promise<{ ok: boolean; error?: string }> {
  if (staffId === actorId) return { ok: false, error: "self" };
  const s = await executor.selectFrom("staff").select(["staff_id", "firstname", "lastname"]).where("staff_id", "=", staffId).executeTakeFirst();
  if (!s) return { ok: false };
  if (await filterActionsReferencing(executor, FILTER_REFS.staff, staffId)) return { ok: false, error: "filter" };
  await executor.deleteFrom("staff").where("staff_id", "=", staffId).execute();
  await executor.updateTable("ticket").set({ staff_id: 0 }).where("staff_id", "=", staffId).execute();
  await executor
    .updateTable("thread_entry")
    .set({ staff_id: 0, poster: `${s.firstname ?? ""} ${s.lastname ?? ""}` })
    .where("staff_id", "=", staffId)
    .execute();
  await executor.deleteFrom("team_member").where("staff_id", "=", staffId).execute();
  await executor.deleteFrom("staff_dept_access").where("staff_id", "=", staffId).execute();
  return { ok: true };
}

export type StaffMassAction = "enable" | "disable" | "delete" | "permissions" | "department";

/** scp/staff.php mass_process. `post`: perms[] per "permissions"; dept_id, role_id, eavesdrop per "department". */
export async function massStaff(executor: DbOrTx, action: StaffMassAction, ids: number[], actorId: number, post: PhpVars = {}): Promise<MassResult> {
  if (!ids.length) return { ok: false, num: 0, error: "select" };
  if ((action === "disable" || action === "delete") && ids.includes(actorId)) return { ok: false, num: 0, error: "self" };
  let num = 0;
  switch (action) {
    case "enable":
    case "disable": {
      const res = await executor.updateTable("staff").set({ isactive: action === "enable" ? 1 : 0 }).where("staff_id", "in", ids).executeTakeFirst();
      num = Number(res.numUpdatedRows);
      return { ok: num > 0, num };
    }
    case "delete": {
      const rows = await executor.selectFrom("staff").select("staff_id").where("staff_id", "in", ids).execute();
      for (const r of rows) {
        if (r.staff_id === actorId) continue;
        const d = await deleteStaff(executor, r.staff_id, actorId);
        if (d.error === "filter") return { ok: num > 0, num, error: "filter" };
        num++;
      }
      return { ok: num > 0, num };
    }
    case "permissions": {
      const rows = await executor.selectFrom("staff").selectAll().where("staff_id", "in", ids).execute();
      for (const r of rows) {
        const s = OrmRow.from("staff", "staff_id", r, STAFF_OPTS);
        // updatePerms senza permessi: permissions = '' e nessun "successo" (return senza valore)
        s.set("permissions", staffPermissions(s, post.perms));
        if (!truthy(post.perms)) continue;
        await s.save(executor);
        num++;
      }
      return { ok: num > 0, num };
    }
    case "department": {
      if (!truthy(post.dept_id) || !truthy(post.role_id) || !(await exists(executor, "department", post.dept_id)) || !(await exists(executor, "role", post.role_id)))
        return { ok: false, num: 0, error: "internal" };
      const rows = await executor.selectFrom("staff").selectAll().where("staff_id", "in", ids).execute();
      for (const r of rows) {
        const s = OrmRow.from("staff", "staff_id", r, STAFF_OPTS);
        let access = await loadAccess(executor, s.num("staff_id"));
        access = await setDepartmentId(executor, s, String(idOf(post.dept_id)), truthy(post.eavesdrop), access);
        s.set("role_id", idOf(post.role_id));
        await s.save(executor);
        for (const a of access) await a.save(executor);
        num++;
      }
      return { ok: num > 0, num };
    }
  }
}
