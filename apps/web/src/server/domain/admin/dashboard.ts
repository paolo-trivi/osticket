import "server-only";

import { sql } from "kysely";

import { db, table } from "../../db";

/** Sintesi per la home dell'area admin: versioni e conteggi degli oggetti gestiti. */
interface AdminSummary {
  schema: string;
  mysql: string;
  node: string;
  helpdeskTitle: string;
  online: boolean;
  counts: Record<"departments" | "topics" | "agents" | "activeAgents" | "admins" | "teams" | "roles" | "slas" | "schedules" | "openTickets" | "users", number>;
}

export async function adminSummary(): Promise<AdminSummary> {
  const executor = db();
  const cfg = await executor.selectFrom("config").select(["key", "value"]).where("namespace", "=", "core").where("key", "in", ["schema_signature", "helpdesk_title", "isonline"]).execute();
  const c = Object.fromEntries(cfg.map((r) => [r.key, r.value]));
  const { rows: v } = await sql<{ v: string }>`SELECT VERSION() AS v`.execute(executor);
  const { rows } = await sql<Record<string, number>>`SELECT
    (SELECT count(*) FROM ${table("department")}) AS departments,
    (SELECT count(*) FROM ${table("help_topic")}) AS topics,
    (SELECT count(*) FROM ${table("staff")}) AS agents,
    (SELECT count(*) FROM ${table("staff")} WHERE isactive = 1) AS activeAgents,
    (SELECT count(*) FROM ${table("staff")} WHERE isadmin = 1) AS admins,
    (SELECT count(*) FROM ${table("team")}) AS teams,
    (SELECT count(*) FROM ${table("role")}) AS roles,
    (SELECT count(*) FROM ${table("sla")}) AS slas,
    (SELECT count(*) FROM ${table("schedule")}) AS schedules,
    (SELECT count(*) FROM ${table("ticket")} t JOIN ${table("ticket_status")} s ON s.id = t.status_id WHERE s.state = 'open') AS openTickets,
    (SELECT count(*) FROM ${table("user")}) AS users`.execute(executor);
  const counts = Object.fromEntries(Object.entries(rows[0] ?? {}).map(([k, n]) => [k, Number(n)])) as AdminSummary["counts"];
  return {
    schema: c.schema_signature ?? "",
    mysql: v[0]?.v ?? "",
    node: process.version,
    helpdeskTitle: c.helpdesk_title ?? "",
    online: c.isonline === "1",
    counts,
  };
}
