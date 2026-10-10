import "server-only";

import { StaffDeptAccess } from "@/lib/osticket/flags";

import type { DbOrTx } from "../../db";
import { phpLooseEquals, str, truthy, type PhpVal } from "../../php/values";
import { OrmRow, setFlag } from "./orm";
import { rebuildPermissions } from "./role";

/** Riga `staff` con dirty tracking e accessi estesi ai reparti, comuni a salvataggio, password e azioni di massa. */

export const STAFF_OPTS = { touchUpdated: true };

/** Staff::lookup($id) come riga con dirty tracking. */
export async function loadStaffRow(executor: DbOrTx, staffId: number): Promise<OrmRow | null> {
  return OrmRow.load(executor, "staff", "staff_id", { staff_id: staffId }, STAFF_OPTS);
}

/** Staff::updatePerms($vars): '' se nessun permesso, altrimenti JSON di RolePermission. */
export function staffPermissions(row: OrmRow, perms: PhpVal): string {
  if (!truthy(perms)) return "";
  return rebuildPermissions(row.get("permissions") as string | null, perms);
}

/**
 * Staff::setDepartmentId($dept_id, $eavesdrop): nuovo reparto primario, eventuale accesso esteso al
 * vecchio reparto (eavesdrop, avvisi attivi), rimozione dell'accesso esteso al nuovo reparto.
 */
export async function setDepartmentId(executor: DbOrTx, row: OrmRow, deptId: PhpVal, eavesdrop: boolean, access: OrmRow[]): Promise<OrmRow[]> {
  const staffId = row.num("staff_id");
  const old = row.get("dept_id");
  if (eavesdrop) {
    const da = OrmRow.create("staff_dept_access", ["staff_id", "dept_id"]);
    da.set("dept_id", old);
    da.set("role_id", row.get("role_id"));
    setFlag(da, StaffDeptAccess.ALERTS, true);
    da.set("staff_id", staffId);
    access.push(da);
  }
  row.set("dept_id", str(deptId));
  const idx = access.findIndex((a) => phpLooseEquals(a.get("dept_id"), deptId as never));
  if (idx >= 0) {
    const [da] = access.splice(idx, 1);
    if (!da.isNew) await da.delete(executor);
  }
  await row.save(executor);
  return access;
}

/** Accessi estesi ai reparti (staff_dept_access) dell'agente. */
export async function loadAccess(executor: DbOrTx, staffId: number): Promise<OrmRow[]> {
  const rows = await executor.selectFrom("staff_dept_access").selectAll().where("staff_id", "=", staffId).execute();
  return rows.map((r) => OrmRow.from("staff_dept_access", ["staff_id", "dept_id"], r));
}
