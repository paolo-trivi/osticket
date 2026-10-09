import "server-only";

import type { DbOrTx } from "../../db";

/**
 * Effetti sui filtri dei ticket delle modifiche agli oggetti admin.
 *
 * 1) FilterAction::setFilterFlags (cambio di stato di reparti e help topic): Filter::setFlag chiama
 *    Filter::update($this->ht) senza le regole (la variabile locale con le regole non viene passata),
 *    quindi la validazione fallisce sempre ("You must set at least one rule") e nel DB non cambia nulla.
 *    Nessuna scrittura da replicare.
 *
 * 2) Signal object.deleted → Filter::disableFilters (eliminazione di reparti, help topic, agenti,
 *    team, SLA): FilterAction::setFilterFlags($fa, …) riceve una singola azione e la scorre con
 *    foreach come se fosse una lista; la chiamata su un array genera un errore fatale DOPO la DELETE
 *    della riga principale e PRIMA delle pulizie (ticket, task, accessi…): il PHP lascia dati
 *    orfani. Non si replica un crash che corrompe i dati: qui l'eliminazione di un oggetto
 *    referenziato da un'azione di filtro viene rifiutata (nessuna scrittura) e l'interfaccia chiede
 *    di modificare prima il filtro.
 */
export type FilterRef = { type: "dept" | "topic" | "agent" | "team" | "sla"; key: "dept_id" | "topic_id" | "staff_id" | "team_id" | "sla_id" };

export const FILTER_REFS = {
  dept: { type: "dept", key: "dept_id" },
  topic: { type: "topic", key: "topic_id" },
  staff: { type: "agent", key: "staff_id" },
  team: { type: "team", key: "team_id" },
  sla: { type: "sla", key: "sla_id" },
} as const satisfies Record<string, FilterRef>;

/** Azioni di filtro che fanno riferimento all'oggetto (configuration LIKE '%"<key>":<id>}'). */
export async function filterActionsReferencing(executor: DbOrTx, ref: FilterRef, id: number): Promise<number> {
  const rows = await executor
    .selectFrom("filter_action")
    .select("id")
    .where("type", "=", ref.type)
    .where("configuration", "like", `%"${ref.key}":${id}}`)
    .execute();
  return rows.length;
}
