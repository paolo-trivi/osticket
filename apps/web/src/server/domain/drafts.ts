import "server-only";

import type { DbOrTx } from "../db";
import { likeEscape } from "../db/like";

/**
 * Draft::deleteForNamespace($namespace, $staff_id) (include/class.draft.php): prima gli allegati delle
 * bozze con namespace che *inizia* per $namespace (startswith: i caratteri jolly vengono escapati), poi le
 * bozze con `namespace LIKE $namespace` (i "%" del namespace restano jolly). Con un agente (id non nullo)
 * solo le sue bozze.
 */
export async function deleteDraftsForNamespace(executor: DbOrTx, namespace: string, staffId?: number): Promise<void> {
  const prefix = likeEscape(namespace) + "%";
  // DELETE A … JOIN draft del PHP, come DELETE con sottoquery (annullabile nelle modifiche admin: changes/)
  let drafts = executor.selectFrom("draft").select("id").where("namespace", "like", prefix);
  if (staffId) drafts = drafts.where("staff_id", "=", staffId);
  await executor.deleteFrom("attachment").where("type", "=", "D").where("object_id", "in", drafts).execute();
  let q = executor.deleteFrom("draft").where("namespace", "like", namespace);
  if (staffId) q = q.where("staff_id", "=", staffId);
  await q.execute();
}
