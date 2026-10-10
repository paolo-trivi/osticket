import "server-only";

import type { DbOrTx } from "../../db";
import { loadConfigNamespace } from "../../config/config";
import { intval, isNumeric, str, type PhpVal } from "../../php/values";

/** Esito delle operazioni di salvataggio dell'area admin (errori come codici, chiave = campo). */
export interface SaveResult {
  ok: boolean;
  id?: number | null;
  errors: Record<string, string>;
}

/** Esito delle azioni di massa (mass_process). */
export interface MassResult {
  ok: boolean;
  num: number;
  error?: string;
}

/** Chiave primaria numerica da un valore del POST (VerySimpleModel::lookup con id stringa). */
export function idOf(v: PhpVal): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : null;
  const s = str(v).trim();
  if (!s || !isNumeric(s)) return null;
  const n = intval(s);
  return n > 0 ? n : null;
}

/**
 * preg_match('`(?!<\\\)#`', $format): il PHP voleva un lookbehind ma ha scritto un lookahead
 * negativo, quindi basta un "#" qualsiasi (bug innocuo replicato).
 */
export function hasHash(format: PhpVal): boolean {
  return str(format).includes("#");
}

/** Esistenza di una riga per chiave primaria (Model::lookup($id) != null). */
export async function exists(executor: DbOrTx, table: "department" | "sla" | "staff" | "email" | "email_template_group" | "role" | "help_topic" | "team" | "schedule" | "form" | "ticket_priority" | "content" | "sequence" | "ticket_status", id: PhpVal): Promise<boolean> {
  const n = idOf(id);
  if (!n) return false;
  const pk: Record<string, string> = {
    department: "id",
    sla: "id",
    staff: "staff_id",
    email: "email_id",
    email_template_group: "tpl_id",
    role: "id",
    help_topic: "topic_id",
    team: "team_id",
    schedule: "id",
    form: "id",
    ticket_priority: "priority_id",
    content: "id",
    sequence: "id",
    ticket_status: "id",
  };
  const row = await (executor.selectFrom(table as never).select(pk[table] as never) as unknown as { where: (c: string, o: string, v: unknown) => { executeTakeFirst: () => Promise<unknown> } })
    .where(pk[table], "=", n)
    .executeTakeFirst();
  return !!row;
}

/** Valori della configurazione core usati dalle regole admin (reparto/SLA/topic predefiniti). */
export async function adminDefaults(executor: DbOrTx): Promise<{ deptId: number; slaId: number; topicId: number; topicSortMode: string }> {
  const cfg = await loadConfigNamespace("core", executor);
  return {
    deptId: cfg.int("default_dept_id"),
    slaId: cfg.int("default_sla_id"),
    topicId: cfg.int("default_help_topic"),
    topicSortMode: cfg.str("help_topic_sort_mode"),
  };
}
