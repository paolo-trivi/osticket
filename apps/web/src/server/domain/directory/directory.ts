import "server-only";

import { sql } from "kysely";

import { db, table, type DbOrTx } from "../../db";
import type { DbDateTime } from "../../db/schema.gen";

/** Utenti finali e organizzazioni (scp/users.php, scp/orgs.php) in sola lettura. */

export interface UserListRow {
  id: number;
  name: string;
  email: string | null;
  org_id: number;
  org_name: string | null;
  created: DbDateTime;
  updated: DbDateTime;
  account_status: number | null;
  tickets: number;
}

export interface Paged<T> {
  rows: T[];
  total: number;
}

const USER_SORT: Record<string, string> = {
  name: "U.name",
  email: "UE.address",
  org: "ORG.name",
  created: "U.created",
  updated: "U.updated",
};

export async function listUsers(
  opts: { q?: string; orgId?: number; sort?: string; desc?: boolean; page: number; pageSize: number },
  executor: DbOrTx = db(),
): Promise<Paged<UserListRow>> {
  const conds = [sql`1 = 1`];
  if (opts.q) {
    const like = `%${opts.q}%`;
    conds.push(sql`(U.name LIKE ${like} OR EXISTS (SELECT 1 FROM ${table("user_email")} X WHERE X.user_id = U.id AND X.address LIKE ${like}) OR ORG.name LIKE ${like})`);
  }
  if (opts.orgId) conds.push(sql`U.org_id = ${opts.orgId}`);
  const where = sql.join(conds, sql` AND `);
  const order = sql.raw(`${USER_SORT[opts.sort ?? "name"] ?? "U.name"} ${opts.desc ? "DESC" : "ASC"}`);
  const from = sql`FROM ${table("user")} U
    LEFT JOIN ${table("user_email")} UE ON (UE.id = U.default_email_id)
    LEFT JOIN ${table("organization")} ORG ON (ORG.id = U.org_id)
    LEFT JOIN ${table("user_account")} UA ON (UA.user_id = U.id)`;
  const [{ rows }, { rows: count }] = await Promise.all([
    sql<UserListRow>`SELECT U.id, U.name, UE.address AS email, U.org_id, ORG.name AS org_name, U.created, U.updated,
        UA.status AS account_status,
        (SELECT COUNT(*) FROM ${table("ticket")} T WHERE T.user_id = U.id) AS tickets
      ${from} WHERE ${where} ORDER BY ${order} LIMIT ${opts.pageSize} OFFSET ${(opts.page - 1) * opts.pageSize}`.execute(executor),
    sql<{ n: number }>`SELECT COUNT(*) AS n ${from} WHERE ${where}`.execute(executor),
  ]);
  return { rows: rows.map((r) => ({ ...r, tickets: Number(r.tickets) })), total: Number(count[0]?.n ?? 0) };
}

export interface UserDetail extends UserListRow {
  emails: string[];
  username: string | null;
  timezone: string | null;
  fields: { label: string; value: string | null }[];
}

/** Stato account (UserAccount::*): 1 confermato, 2 bloccato, 4 reset password richiesto, 8 ... */
export async function loadUser(id: number, executor: DbOrTx = db()): Promise<UserDetail | null> {
  const { rows } = await listUsersById([id], executor);
  const base = rows[0];
  if (!base) return null;
  const [emails, account, fields] = await Promise.all([
    executor.selectFrom("user_email").select("address").where("user_id", "=", id).execute(),
    executor.selectFrom("user_account").select(["username", "timezone"]).where("user_id", "=", id).executeTakeFirst(),
    formAnswers("U", id, executor),
  ]);
  return {
    ...base,
    emails: emails.map((e) => e.address),
    username: account?.username ?? null,
    timezone: account?.timezone ?? null,
    fields,
  };
}

async function listUsersById(ids: number[], executor: DbOrTx) {
  return sql<UserListRow>`SELECT U.id, U.name, UE.address AS email, U.org_id, ORG.name AS org_name, U.created, U.updated,
      UA.status AS account_status, (SELECT COUNT(*) FROM ${table("ticket")} T WHERE T.user_id = U.id) AS tickets
    FROM ${table("user")} U
    LEFT JOIN ${table("user_email")} UE ON (UE.id = U.default_email_id)
    LEFT JOIN ${table("organization")} ORG ON (ORG.id = U.org_id)
    LEFT JOIN ${table("user_account")} UA ON (UA.user_id = U.id)
    WHERE U.id IN (${sql.join(ids)})`.execute(executor);
}

/** Valori dei form dinamici di un oggetto (U utente, O organizzazione), esclusi i campi base. */
export async function formAnswers(objectType: "U" | "O", objectId: number, executor: DbOrTx = db()) {
  const { rows } = await sql<{ label: string; value: string | null }>`
    SELECT FF.label, V.value FROM ${table("form_entry")} FE
    JOIN ${table("form_entry_values")} V ON (V.entry_id = FE.id)
    JOIN ${table("form_field")} FF ON (FF.id = V.field_id)
    WHERE FE.object_type = ${objectType} AND FE.object_id = ${objectId}
      AND FF.name NOT IN ('name', 'email') AND FF.type NOT IN ('break', 'info')
    ORDER BY FE.sort, FF.sort`.execute(executor);
  return rows;
}

export interface OrgListRow {
  id: number;
  name: string;
  domain: string;
  created: DbDateTime;
  updated: DbDateTime;
  users: number;
}

export async function listOrgs(
  opts: { q?: string; sort?: string; desc?: boolean; page: number; pageSize: number },
  executor: DbOrTx = db(),
): Promise<Paged<OrgListRow>> {
  const where = opts.q ? sql`O.name LIKE ${`%${opts.q}%`}` : sql`1 = 1`;
  const sortCol = { name: "O.name", users: "users", created: "O.created", updated: "O.updated" }[opts.sort ?? "name"] ?? "O.name";
  const order = sql.raw(`${sortCol} ${opts.desc ? "DESC" : "ASC"}`);
  const [{ rows }, { rows: count }] = await Promise.all([
    sql<OrgListRow>`SELECT O.id, O.name, O.domain, O.created, O.updated,
        (SELECT COUNT(*) FROM ${table("user")} U WHERE U.org_id = O.id) AS users
      FROM ${table("organization")} O WHERE ${where} ORDER BY ${order}
      LIMIT ${opts.pageSize} OFFSET ${(opts.page - 1) * opts.pageSize}`.execute(executor),
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${table("organization")} O WHERE ${where}`.execute(executor),
  ]);
  return { rows: rows.map((r) => ({ ...r, users: Number(r.users) })), total: Number(count[0]?.n ?? 0) };
}

export async function loadOrg(id: number, executor: DbOrTx = db()) {
  const org = await executor
    .selectFrom("organization")
    .select(["id", "name", "domain", "manager", "status", "created", "updated", "extra"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!org) return null;
  return { ...org, fields: await formAnswers("O", id, executor) };
}
