import "server-only";

import { sql } from "kysely";

import { NOW, table, type DbOrTx } from "../../db";

export const CollabFlag = { ACTIVE: 0x0001, CC: 0x0002 } as const;

/**
 * scp/tickets.php (reply): riattiva i collaboratori riselezionati, disattiva quelli deselezionati;
 * Collaborator::save scrive `updated = NOW()` solo se i flag cambiano.
 */
export async function syncActiveCollaborators(executor: DbOrTx, threadId: number, selectedUserIds: number[]): Promise<void> {
  const collabs = await executor.selectFrom("thread_collaborator").select(["id", "user_id", "flags"]).where("thread_id", "=", threadId).execute();
  for (const c of collabs) {
    const active = !!(c.flags & CollabFlag.ACTIVE);
    const selected = selectedUserIds.includes(c.user_id);
    let flags = c.flags;
    if (!active && selected) flags |= CollabFlag.ACTIVE;
    else if (active && !selected) flags &= ~CollabFlag.ACTIVE;
    if (flags !== c.flags) {
      await executor.updateTable("thread_collaborator").set({ flags, updated: NOW }).where("id", "=", c.id).execute();
    }
  }
}

/** Banlist::isBanned: regola email attiva nel filtro "SYSTEM BAN LIST". */
export async function isEmailBanned(executor: DbOrTx, address: string): Promise<boolean> {
  if (!address) return false;
  const { rows } = await sql<{ id: number }>`SELECT F.id FROM ${table("filter")} F
    JOIN ${table("filter_rule")} R ON (F.id = R.filter_id)
    WHERE F.name = 'SYSTEM BAN LIST' AND F.isactive AND R.isactive AND R.what = 'email' AND R.val = ${address}
    LIMIT 1`.execute(executor);
  return rows.length > 0;
}

/** Draft::deleteForNamespace($ns, $staffId) con namespace esatto (es. ticket.response.<id>). */
export async function deleteDraftsFor(executor: DbOrTx, namespace: string, staffId: number): Promise<void> {
  const like = namespace.replace(/([%_\\])/g, "\\$1") + "%";
  await sql`DELETE A FROM ${table("attachment")} A JOIN ${table("draft")} D ON (A.type = 'D' AND A.object_id = D.id)
    WHERE D.namespace LIKE ${like} AND D.staff_id = ${staffId}`.execute(executor);
  await executor.deleteFrom("draft").where("namespace", "like", namespace).where("staff_id", "=", staffId).execute();
}
