import "server-only";

import { sql } from "kysely";

import type { DbOrTx } from "../../db";
import { sanitizeText } from "../../format/text";
import { adminDefaults, type MassResult, type SaveResult } from "./common";
import { FILTER_REFS, filterActionsReferencing } from "./filters";
import { OrmRow, SQL_NOW } from "./orm";
import { htmlcharsVars, intval, isNumeric, isset, phpLooseEquals, str, truthy, type PhpVars } from "./php";

/** SLA: scp/slas.php → SLA::update / SLA::delete / mass_process (include/class.sla.php). */
export const SlaFlag = { ACTIVE: 0x0001, ESCALATE: 0x0002, NOALERTS: 0x0004, TRANSIENT: 0x0008 } as const;

const SLA_OPTS = { touchUpdated: true };

/** SLA::update($vars, $errors) — creazione se slaId è null (SLA::create()). */
export async function saveSla(executor: DbOrTx, slaId: number | null, input: PhpVars): Promise<SaveResult> {
  const errors: Record<string, string> = {};
  let sla: OrmRow;
  if (slaId) {
    const row = await OrmRow.load(executor, "sla", "id", { id: slaId }, SLA_OPTS);
    if (!row) return { ok: false, errors: { err: "not_found" } };
    sla = row;
  } else {
    sla = OrmRow.create("sla", "id", SLA_OPTS);
    sla.set("created", SQL_NOW);
  }
  // Format::htmlchars($vars): anche nome e note sono salvati con le entità HTML
  const vars = htmlcharsVars(input);
  if (!truthy(vars.grace_period)) errors.grace_period = "required";
  else if (!isNumeric(vars.grace_period)) errors.grace_period = "numeric";
  else if (Number(str(vars.grace_period)) > 8760) errors.grace_period = "max";
  if (!truthy(vars.name)) errors.name = "required";
  else {
    const row = await executor.selectFrom("sla").select("id").where("name", "=", str(vars.name)).executeTakeFirst();
    if (row?.id && !phpLooseEquals(row.id, vars.id as never)) errors.name = "exists";
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  const noAlerts = isset(vars, "disable_overdue_alerts") ? SlaFlag.NOALERTS : 0;
  const transient = isset(vars, "transient") ? SlaFlag.TRANSIENT : 0;
  sla.set("name", str(vars.name));
  sla.set("schedule_id", vars.schedule_id === undefined || vars.schedule_id === null ? null : str(vars.schedule_id));
  sla.set("grace_period", str(vars.grace_period));
  sla.set("notes", sanitizeText(str(vars.notes)));
  sla.set("flags", (truthy(vars.isactive) ? SlaFlag.ACTIVE : 0) | noAlerts | intval(vars.enable_priority_escalation) | transient);
  await sla.save(executor);
  return { ok: true, id: sla.num("id"), errors: {} };
}

/**
 * SLA::delete(): non lo SLA predefinito; reparti e topic perdono lo SLA, i ticket passano allo SLA
 * predefinito.
 */
export async function deleteSla(executor: DbOrTx, slaId: number): Promise<{ ok: boolean; error?: string }> {
  const { slaId: def } = await adminDefaults(executor);
  if (slaId === def) return { ok: false, error: "default" };
  if (await filterActionsReferencing(executor, FILTER_REFS.sla, slaId)) return { ok: false, error: "filter" };
  const res = await executor.deleteFrom("sla").where("id", "=", slaId).executeTakeFirst();
  if (!Number(res.numDeletedRows)) return { ok: false };
  await executor.updateTable("department").set({ sla_id: 0 }).where("sla_id", "=", slaId).execute();
  await executor.updateTable("help_topic").set({ sla_id: 0 }).where("sla_id", "=", slaId).execute();
  await executor.updateTable("ticket").set({ sla_id: def }).where("sla_id", "=", slaId).execute();
  return { ok: true };
}

export type SlaMassAction = "enable" | "disable" | "delete";

/** scp/slas.php mass_process (enable/disable con UPDATE diretto dei flag, senza `updated`). */
export async function massSla(executor: DbOrTx, action: SlaMassAction, ids: number[]): Promise<MassResult> {
  if (!ids.length) return { ok: false, num: 0, error: "select" };
  switch (action) {
    case "enable":
    case "disable": {
      const expr = action === "enable" ? sql<number>`flags | ${SlaFlag.ACTIVE}` : sql<number>`flags & ${~SlaFlag.ACTIVE >>> 0}`;
      const res = await executor.updateTable("sla").set({ flags: expr }).where("id", "in", ids).executeTakeFirst();
      const num = Number(res.numUpdatedRows);
      return { ok: num > 0, num };
    }
    case "delete": {
      let num = 0;
      for (const id of ids) {
        const r = await deleteSla(executor, id);
        if (r.error === "filter") return { ok: num > 0, num, error: "filter" };
        if (r.ok) num++;
      }
      return { ok: num > 0, num };
    }
  }
}
