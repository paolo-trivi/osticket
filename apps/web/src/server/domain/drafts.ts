import "server-only";

import { sql } from "kysely";

import { table, type DbOrTx } from "../db";

/**
 * Draft::deleteForNamespace($namespace, $staff_id) (include/class.draft.php): prima gli allegati delle
 * bozze con namespace che *inizia* per $namespace (startswith: i caratteri jolly vengono escapati), poi le
 * bozze con `namespace LIKE $namespace` (i "%" del namespace restano jolly). Con un agente (id non nullo)
 * solo le sue bozze.
 */
export async function deleteDraftsForNamespace(executor: DbOrTx, namespace: string, staffId?: number): Promise<void> {
  const prefix = namespace.replace(/([%_\\])/g, "\\$1") + "%";
  await sql`DELETE A FROM ${table("attachment")} A JOIN ${table("draft")} D ON (A.type = 'D' AND A.object_id = D.id)
    WHERE D.namespace LIKE ${prefix}${staffId ? sql` AND D.staff_id = ${staffId}` : sql``}`.execute(executor);
  let q = executor.deleteFrom("draft").where("namespace", "like", namespace);
  if (staffId) q = q.where("staff_id", "=", staffId);
  await q.execute();
}
