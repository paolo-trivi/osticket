import "server-only";

import { CustomQueue } from "@/lib/osticket/flags";

import type { DbOrTx } from "../../db";
import type { MassResult } from "../admin/common";
import { OrmRow } from "../admin/orm";

/**
 * Code dei ticket (scp/queues.php, include/class.queue.php).
 * Creazione e modifica (CustomQueue::update) ricostruiscono criteri, colonne, ordinamenti ed
 * esportazioni dai form di ricerca avanzata del PHP: restano al pannello PHP. Qui: elenco e azioni
 * di massa (enable/disable con save() → updated=NOW(); delete = DELETE della sola riga come
 * VerySimpleModel::delete, le code figlie e le colonne restano). SavedQueue::clearCounts svuota
 * solo la cache APCu del PHP.
 */

export async function listQueues(executor: DbOrTx) {
  const rows = await executor
    .selectFrom("queue as q")
    .leftJoin("staff as s", "s.staff_id", "q.staff_id")
    .select((eb) => [
      "q.id",
      "q.parent_id",
      "q.title",
      "q.flags",
      "q.staff_id",
      "q.sort",
      "q.path",
      "q.root",
      "q.created",
      "q.updated",
      "s.firstname",
      "s.lastname",
      eb.selectFrom("queue_columns as c").select((e) => e.fn.countAll<number>().as("n")).whereRef("c.queue_id", "=", "q.id").as("columns"),
    ])
    .orderBy("q.sort")
    .orderBy("q.title")
    .execute();
  return rows.map((r) => ({ ...r, columns: Number(r.columns) }));
}

export type QueueMassAction = "enable" | "disable" | "delete";

/** scp/queues.php do=mass_process */
export async function massQueues(executor: DbOrTx, action: QueueMassAction, ids: number[]): Promise<MassResult> {
  if (!ids.length) return { ok: false, num: 0, error: "select_one" };
  const def = await executor.selectFrom("config").select("value").where("namespace", "=", "core").where("key", "=", "default_ticket_queue").executeTakeFirst();
  // OsticketConfig::getDefaultTicketQueueId(): 1 se la chiave manca
  const defaultId = def ? Number(def.value) || 0 : 1;
  let updated = 0;
  let error: string | undefined;
  const rows = await executor.selectFrom("queue").selectAll().where("id", "in", ids).orderBy("sort").orderBy("title").execute();
  for (const r of rows) {
    const q = OrmRow.from("queue", "id", r as unknown as Record<string, unknown>, { touchUpdated: true });
    if (action === "enable" || action === "disable") {
      const flags = q.num("flags");
      q.set("flags", action === "disable" ? flags | CustomQueue.DISABLED : flags & ~CustomQueue.DISABLED);
      await q.save(executor);
      updated++;
    } else if (r.id === defaultId) {
      error = "default_queue";
    } else {
      await executor.deleteFrom("queue").where("id", "=", r.id).execute();
      updated++;
    }
  }
  return updated ? { ok: true, num: updated } : { ok: false, num: 0, error: error ?? "failed" };
}
