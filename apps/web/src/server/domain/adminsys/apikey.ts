import "server-only";

import { isIP } from "node:net";

import { sql } from "kysely";

import { table, type DbOrTx } from "../../db";
import { randCode } from "../../mail/message-id";
import { str, truthy, type PhpVars } from "../../php/values";
import type { MassResult, SaveResult } from "../admin/common";
import type { Errors } from "../admin/validator";
import { sanitizeHtml } from "./sanitize";

/**
 * Chiavi API: scp/apikeys.php → API::save / API::delete (include/class.api.php), SQL diretto.
 * I valori arrivano come db_input(): un campo assente diventa '' (0 nelle colonne numeriche con
 * SQL_MODE vuoto). L'indirizzo IP si imposta solo alla creazione; la chiave è casuale (48 caratteri).
 */
const KEY_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** API::save($id, $vars, $errors) */
export async function saveApiKey(executor: DbOrTx, id: number | null, vars: PhpVars): Promise<SaveResult> {
  const errors: Errors = {};
  if (id) {
    const row = await executor.selectFrom("api_key").select("id").where("id", "=", id).executeTakeFirst();
    if (!row) return { ok: false, errors: { err: "unknown" } };
  }
  if (!id && (!truthy(vars.ipaddr) || !isIP(str(vars.ipaddr)))) errors.ipaddr = "valid_ip_required";
  if (Object.keys(errors).length) return { ok: false, errors };
  const set = sql`updated=NOW(), isactive=${str(vars.isactive)}, can_create_tickets=${str(vars.can_create_tickets)}, can_exec_cron=${str(vars.can_exec_cron)}, notes=${sanitizeHtml(str(vars.notes))}`;
  if (id) {
    await sql`UPDATE ${table("api_key")} SET ${set} WHERE id=${id}`.execute(executor);
    return { ok: true, id, errors };
  }
  const res = await sql`INSERT INTO ${table("api_key")} SET ${set}, created=NOW(), ipaddr=${str(vars.ipaddr)}, apikey=${randCode(48, KEY_CHARS)}`.execute(executor);
  return { ok: true, id: Number(res.insertId), errors };
}

export type ApiKeyMassAction = "enable" | "disable" | "delete";

/** scp/apikeys.php do=mass_process */
export async function massApiKeys(executor: DbOrTx, action: ApiKeyMassAction, ids: number[]): Promise<MassResult> {
  if (!ids.length) return { ok: false, num: 0, error: "select_one" };
  if (action === "delete") {
    let i = 0;
    for (const id of ids) {
      const r = await executor.deleteFrom("api_key").where("id", "=", id).executeTakeFirst();
      if (Number(r.numDeletedRows)) i++;
    }
    return i ? { ok: true, num: i } : { ok: false, num: 0, error: "failed" };
  }
  const value = action === "enable" ? 1 : 0;
  // db_affected_rows(): solo le righe che cambiano
  const n = await executor.selectFrom("api_key").select((eb) => eb.fn.countAll<number>().as("n")).where("id", "in", ids).where("isactive", "<>", value).executeTakeFirstOrThrow();
  await sql`UPDATE ${table("api_key")} SET isactive=${value} WHERE id IN (${sql.join(ids)})`.execute(executor);
  const num = Number(n.n);
  return num ? { ok: true, num } : { ok: false, num: 0, error: "failed" };
}

export async function listApiKeys(executor: DbOrTx) {
  return executor.selectFrom("api_key").selectAll().orderBy("created", "desc").execute();
}

