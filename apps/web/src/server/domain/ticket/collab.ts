import "server-only";

import { sql } from "kysely";

import { Collaborator } from "@/lib/osticket/flags";

import { NOW, table, type DbOrTx } from "../../db";

/**
 * scp/tickets.php (reply): riattiva i collaboratori riselezionati, disattiva quelli deselezionati;
 * Collaborator::save scrive `updated = NOW()` solo se i flag cambiano.
 */
export async function syncActiveCollaborators(executor: DbOrTx, threadId: number, selectedUserIds: number[]): Promise<void> {
  const collabs = await executor.selectFrom("thread_collaborator").select(["id", "user_id", "flags"]).where("thread_id", "=", threadId).execute();
  for (const c of collabs) {
    const active = !!(c.flags & Collaborator.ACTIVE);
    const selected = selectedUserIds.includes(c.user_id);
    let flags = c.flags;
    if (!active && selected) flags |= Collaborator.ACTIVE;
    else if (active && !selected) flags &= ~Collaborator.ACTIVE;
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

/** Draft::deleteForNamespace($ns, $staffId) (es. ticket.response.<id>): vedi ../drafts.ts */
export { deleteDraftsForNamespace as deleteDraftsFor } from "../drafts";
