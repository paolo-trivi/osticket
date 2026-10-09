import "server-only";

import { sql } from "kysely";

import type { ConfigNamespace } from "../../config/config";
import { table, type DbOrTx } from "../../db";
import { companyVar, deptVar, entryVar, FormattedDate, loadStaffInfo, staffVar, type EntryInfo } from "../../mail/objects";
import { VarBag, VariableReplacer, type TemplateVariable } from "../../mail/variables";
import { answerToString } from "../../mail/objects";
import type { TaskDbRow } from "./model";
import { TaskFlag } from "./tasks";

/**
 * Oggetto `task` dei template email (Task::getVar / asVar, include/class.task.php:1095):
 * prima i getter get<Tag>(), poi i casi speciali, poi le risposte del form del task.
 */
export async function taskVar(executor: DbOrTx, task: TaskDbRow, cfg: ConfigNamespace, dbZone: string): Promise<TemplateVariable> {
  const base = cfg.str("helpdesk_url").replace(/\/+$/, "");
  const [dept, staff, team, answers, original] = await Promise.all([
    deptVar(executor, task.dept_id, cfg),
    loadStaffInfo(executor, task.staff_id),
    task.team_id ? executor.selectFrom("team").select(["team_id", "name"]).where("team_id", "=", task.team_id).executeTakeFirst() : undefined,
    sql<{ name: string; type: string; value: string | null }>`SELECT FF.name, FF.type, V.value FROM ${table("form_entry")} FE
      JOIN ${table("form_entry_values")} V ON (V.entry_id = FE.id)
      JOIN ${table("form_field")} FF ON (FF.id = V.field_id)
      WHERE FE.object_type = 'A' AND FE.object_id = ${task.id} ORDER BY FE.sort, FF.sort`.execute(executor),
    sql<{ body: string }>`SELECT E.body FROM ${table("thread_entry")} E JOIN ${table("thread")} T ON (T.id = E.thread_id)
      WHERE T.object_type = 'A' AND T.object_id = ${task.id} AND E.type = 'M' AND (E.flags & 1) != 0 ORDER BY E.id LIMIT 1`.execute(executor),
  ]);
  const ans = new Map<string, string>();
  for (const r of answers.rows) if (r.name && !ans.has(r.name.toLowerCase())) ans.set(r.name.toLowerCase(), answerToString(r.type, r.value));
  const open = (task.flags & TaskFlag.ISOPEN) !== 0;
  const staffV = staff ? staffVar(staff, cfg) : null;
  const teamV = team ? new VarBag({ name: team.name, id: team.team_id }, team.name) : null;
  const assigned = [staffV ? staffV.asVar(new VariableReplacer()) : "", team?.name ?? ""].filter(Boolean).join("/");
  const date = (v: string | null) => (v ? new FormattedDate(v, cfg, dbZone) : false);
  const title = ans.get("title") ?? "";
  const getters: Record<string, () => unknown> = {
    id: () => task.id,
    number: () => task.number,
    title: () => title,
    status: () => (open ? "Open" : "Completed"),
    dept: () => dept ?? "",
    staff: () => staffV ?? "",
    team: () => teamV ?? "",
    assigned: () => assigned,
    // Format::display del messaggio originale (corpo HTML, URL resi cliccabili dal PHP)
    description: () => original.rows[0]?.body ?? "",
    subject: () => title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"),
    staff_link: () => `${base}/scp/tasks.php?id=${task.id}`,
    ticket_link: () =>
      task.object_type === "T" && task.object_id ? `${base}/scp/tickets.php?id=${task.object_id}#tasks` : `${base}/scp/tasks.php?id=${task.id}`,
    create_date: () => date(task.created),
    due_date: () => date(task.duedate),
    close_date: () => (open ? false : date(task.closed)),
    last_update: () => date(task.updated),
  };
  return {
    getVar(tag: string) {
      const g = getters[tag];
      if (g) {
        const v = g();
        return v === false ? "" : v;
      }
      if (ans.has(tag)) return ans.get(tag);
      return false;
    },
    asVar() {
      return task.number;
    },
  };
}

/** ThreadActivity */
export function activityVar(title: string, desc: string): TemplateVariable {
  return new VarBag({ title, description: desc }, title);
}

export async function threadEntryVar(executor: DbOrTx, entryId: number, cfg: ConfigNamespace, dbZone: string): Promise<TemplateVariable | null> {
  const row = await executor.selectFrom("thread_entry").selectAll().where("id", "=", entryId).executeTakeFirst();
  if (!row) return null;
  const poster = await loadStaffInfo(executor, row.staff_id);
  return entryVar(row as unknown as EntryInfo, cfg, dbZone, poster ? staffVar(poster, cfg) : null);
}

export { companyVar };
