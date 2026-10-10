import "server-only";

import { NOW, type DbOrTx } from "../../db";
import { phpLooseEquals } from "../ticket/record";
import type { Agent } from "./staff";

/** Scritture dell'agente su sé stesso (profilo, password, 2FA): config "staff.<id>" e riga staff. */

/** Config::updateAll sul namespace "staff.<id>": INSERT delle chiavi nuove, UPDATE di quelle cambiate. */
export async function updateStaffConfig(executor: DbOrTx, staffId: number, values: Record<string, string>): Promise<void> {
  const ns = `staff.${staffId}`;
  const rows = await executor.selectFrom("config").select(["id", "key", "value"]).where("namespace", "=", ns).execute();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const [key, value] of Object.entries(values)) {
    const row = byKey.get(key);
    if (!row) await executor.insertInto("config").values({ namespace: ns, key, value, updated: NOW }).execute();
    else if (!phpLooseEquals(row.value, value)) await executor.updateTable("config").set({ value, updated: NOW }).where("id", "=", row.id).execute();
  }
}

/** Salvataggio di Staff (Staff::save): solo colonne cambiate (confronto debole), updated = NOW se sporco. */
export async function saveStaffChanges(executor: DbOrTx, agent: Agent, values: Record<string, unknown>): Promise<void> {
  const set: Record<string, unknown> = {};
  const row = agent.row as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(values)) {
    if (v === NOW || !phpLooseEquals(row[k], v)) set[k] = v;
  }
  if (!Object.keys(set).length) return;
  set.updated = NOW;
  await executor.updateTable("staff").set(set as never).where("staff_id", "=", agent.id).execute();
}
