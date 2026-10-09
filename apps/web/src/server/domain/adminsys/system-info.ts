import "server-only";

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { sql } from "kysely";

import { type DbOrTx } from "../../db";
import { detectDbTimezone } from "../../db/time";
import { installConfig } from "../../env";

/**
 * Informazioni di sistema (scp/system.php, include/staff/system.inc.php). Il PHP non gira dentro
 * Next: versione di osTicket letta da bootstrap.php dell'installazione, dati del database e del
 * runtime Node/Next al posto di PHP ed estensioni.
 */
export interface SystemInfo {
  osticketVersion: string | null;
  nodeVersion: string;
  nextVersion: string | null;
  dbVersion: string;
  dbName: string;
  dbHost: string;
  tablePrefix: string;
  schemaSignature: string;
  spaceUsedMiB: number;
  attachmentsMiB: number;
  dbTimezone: string;
  configuredDbTimezone: string;
  languages: string[];
  plugins: number;
}

function osticketVersion(): string | null {
  const cfg = process.env.OST_CONFIG_PATH;
  if (!cfg) return null;
  const file = join(dirname(dirname(cfg)), "bootstrap.php");
  if (!existsSync(file)) return null;
  const src = readFileSync(file, "utf8");
  const major = /define\('MAJOR_VERSION',\s*'([^']+)'\)/.exec(src)?.[1];
  const git = /define\('GIT_VERSION',\s*'([^']+)'\)/.exec(src)?.[1];
  const self = /define\('THIS_VERSION',\s*([^;]+)\)/.exec(src)?.[1] ?? "";
  if (/^'[^']+'$/.test(self.trim())) return self.trim().slice(1, -1);
  return major ? `${major}${self.includes("-git") ? "-git" : ""}${git && !git.startsWith("$") ? ` (${git})` : ""}` : null;
}

function nextVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "node_modules", "next", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function languages(): string[] {
  const cfg = process.env.OST_CONFIG_PATH;
  if (!cfg) return [];
  const dir = join(dirname(cfg), "i18n");
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => (e.isDirectory() && /^[a-z]{2}(_[A-Za-z0-9]+)?$/.test(e.name)) || e.name.endsWith(".phar"))
      .map((e) => e.name.replace(/\.phar$/, ""));
  } catch {
    return [];
  }
}

export async function systemInfo(executor: DbOrTx): Promise<SystemInfo> {
  const ic = installConfig();
  const version = await sql<{ v: string }>`SELECT VERSION() AS v`.execute(executor);
  const space = await sql<{ total: string | null }>`SELECT SUM(data_length + index_length) / 1048576 AS total FROM information_schema.TABLES WHERE table_schema = ${ic.dbName}`.execute(executor);
  const att = await sql<{ total: string | null }>`SELECT (DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024 AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${ic.dbName} AND TABLE_NAME = ${`${ic.tablePrefix}file_chunk`}`.execute(executor);
  const cfg = await executor
    .selectFrom("config")
    .select(["key", "value"])
    .where("namespace", "=", "core")
    .where("key", "in", ["schema_signature", "db_timezone"])
    .execute();
  const plugins = await executor.selectFrom("plugin").select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
  return {
    osticketVersion: osticketVersion(),
    nodeVersion: process.version,
    nextVersion: nextVersion(),
    dbVersion: version.rows[0]?.v ?? "",
    dbName: ic.dbName,
    dbHost: ic.dbHost,
    tablePrefix: ic.tablePrefix,
    schemaSignature: cfg.find((c) => c.key === "schema_signature")?.value ?? "",
    spaceUsedMiB: Number(space.rows[0]?.total ?? 0),
    attachmentsMiB: Number(att.rows[0]?.total ?? 0),
    dbTimezone: await detectDbTimezone(executor),
    configuredDbTimezone: cfg.find((c) => c.key === "db_timezone")?.value ?? "",
    languages: languages(),
    plugins: Number(plugins.n),
  };
}
