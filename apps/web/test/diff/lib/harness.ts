import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createConnection, type Connection, type RowDataPacket } from "mysql2/promise";

import { installConfig } from "@/server/env";

import { maskAlertTime } from "./alert-time";

/**
 * Harness differenziale: la stessa operazione viene eseguita
 *  (a) dal codice PHP originale di osTicket sul DB `<base>_diff_php`
 *  (b) dal servizio TypeScript sul DB `<base>_diff_ts`
 * partendo dallo stesso snapshot; poi si confrontano tutte le tabelle normalizzate.
 */
const run = promisify(execFile);

export const OST_ROOT = process.env.OST_DIR ?? "/home/user/ost-dev/www";
const BASE_DB = process.env.OST_DIFF_SOURCE_DB ?? "osticket";
/** OST_DIFF_TAG separa i DB di lavoro di suite eseguite in parallelo (es. "assign" → osticket_diff_assign_php) */
const TAG = process.env.OST_DIFF_TAG ? `_${process.env.OST_DIFF_TAG}` : "";
const SNAPSHOT_DB = `${BASE_DB}_diff${TAG}_base`;
export const PHP_DB = `${BASE_DB}_diff${TAG}_php`;
export const TS_DB = `${BASE_DB}_diff${TAG}_ts`;
/** mail() del PHP consegna a Mailpit (SMTP finto dell'ambiente di sviluppo); porta per suite con MAILPIT_SMTP_PORT */
const SENDMAIL =
  process.env.OST_SENDMAIL ?? `/home/user/ost-dev/bin/mailpit sendmail -S 127.0.0.1:${process.env.MAILPIT_SMTP_PORT ?? "1025"}`;

async function connect(): Promise<Connection> {
  const cfg = installConfig();
  return createConnection({
    host: cfg.dbHost,
    port: cfg.dbPort,
    user: cfg.dbUser,
    password: cfg.dbPass,
    dateStrings: true,
    multipleStatements: false,
  });
}

async function tablesOf(conn: Connection, dbName: string): Promise<string[]> {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name",
    [dbName],
  );
  return rows.map((r) => String(r.t));
}

/** Copia completa di un database (struttura + dati). */
async function cloneDatabase(source: string, target: string): Promise<void> {
  const conn = await connect();
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${target}\``);
    await conn.query(`CREATE DATABASE \`${target}\` DEFAULT CHARACTER SET utf8 COLLATE utf8_general_ci`);
    for (const t of await tablesOf(conn, source)) {
      await conn.query(`CREATE TABLE \`${target}\`.\`${t}\` LIKE \`${source}\`.\`${t}\``);
      await conn.query(`INSERT INTO \`${target}\`.\`${t}\` SELECT * FROM \`${source}\`.\`${t}\``);
    }
  } finally {
    await conn.end();
  }
}

/** Crea lo snapshot di partenza (una volta per suite) a partire dal DB di sviluppo. */
export async function prepareSnapshot(): Promise<void> {
  await cloneDatabase(BASE_DB, SNAPSHOT_DB);
}

/** Ripristina i due DB di lavoro allo snapshot. */
export async function resetWorkingDatabases(): Promise<void> {
  await Promise.all([cloneDatabase(SNAPSHOT_DB, PHP_DB), cloneDatabase(SNAPSHOT_DB, TS_DB)]);
}

interface PhpOp {
  op: string;
  args?: Record<string, unknown>;
  ip?: string;
}

/** Esegue un'operazione con il PHP originale (test/diff/php/runner.php) sul DB indicato. */
export async function runPhp<T = Record<string, unknown>>(op: PhpOp, dbName = PHP_DB): Promise<T> {
  const { stdout } = await run("php", ["-d", `sendmail_path=${SENDMAIL}`, `${__dirname}/../php/runner.php`, OST_ROOT, dbName, JSON.stringify(op)], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const line = stdout.trim().split("\n").pop() ?? "{}";
  return JSON.parse(line) as T;
}

export type Row = Record<string, unknown>;
type Dump = Record<string, Row[]>;

interface NormalizeOptions {
  /** colonne da ignorare, nella forma "tabella.colonna" (senza prefisso) o "*.colonna" */
  ignore?: string[];
  /** tabelle da escludere (senza prefisso); default: session (sessioni HTTP del PHP, non dati di dominio) */
  ignoreTables?: string[];
  /** finestra (secondi) entro cui un datetime è considerato "adesso" */
  nowWindowSec?: number;
}

const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Dump di tutte le tabelle, righe ordinate, datetime "recenti" sostituiti da <NOW>. */
async function dumpDatabase(dbName: string, opts: NormalizeOptions = {}): Promise<Dump> {
  const conn = await connect();
  const prefix = installConfig().tablePrefix;
  const window = opts.nowWindowSec ?? 600;
  const ignore = new Set(opts.ignore ?? []);
  const ignoreTables = new Set(opts.ignoreTables ?? ["session"]);
  try {
    const [[{ now }]] = await conn.query<RowDataPacket[]>("SELECT NOW() AS now");
    const nowMs = Date.parse(String(now).replace(" ", "T") + "Z");
    const out: Dump = {};
    for (const t of await tablesOf(conn, dbName)) {
      const name = t.startsWith(prefix) ? t.slice(prefix.length) : t;
      if (ignoreTables.has(name)) continue;
      const [rows] = await conn.query<RowDataPacket[]>(`SELECT * FROM \`${dbName}\`.\`${t}\``);
      out[name] = rows
        .map((r) => {
          const row: Row = {};
          for (const [col, value] of Object.entries(r)) {
            if (ignore.has(`${name}.${col}`) || ignore.has(`*.${col}`)) continue;
            if (typeof value === "string" && DATETIME_RE.test(value)) {
              const ms = Date.parse(value.replace(" ", "T") + "Z");
              row[col] = Math.abs(ms - nowMs) <= window * 1000 ? "<NOW>" : value;
            } else if (name === "syslog" && col === "log" && typeof value === "string") {
              row[col] = maskAlertTime(value);
            } else if (Buffer.isBuffer(value)) {
              row[col] = `<bin:${value.toString("hex").slice(0, 64)}>`;
            } else {
              row[col] = value;
            }
          }
          return row;
        })
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return out;
  } finally {
    await conn.end();
  }
}

export interface TableDiff {
  table: string;
  onlyInPhp: Row[];
  onlyInTs: Row[];
}

/** Differenze riga per riga tra i dump PHP e TS (vuoto = comportamento identico). */
function diffDumps(php: Dump, ts: Dump): TableDiff[] {
  const diffs: TableDiff[] = [];
  for (const table of new Set([...Object.keys(php), ...Object.keys(ts)])) {
    const a = (php[table] ?? []).map((r) => JSON.stringify(r));
    const b = (ts[table] ?? []).map((r) => JSON.stringify(r));
    const counts = new Map<string, number>();
    for (const r of b) counts.set(r, (counts.get(r) ?? 0) + 1);
    const onlyInPhp: Row[] = [];
    for (const r of a) {
      const c = counts.get(r) ?? 0;
      if (c > 0) counts.set(r, c - 1);
      else onlyInPhp.push(JSON.parse(r));
    }
    const onlyInTs: Row[] = [];
    for (const [r, c] of counts) for (let i = 0; i < c; i++) onlyInTs.push(JSON.parse(r));
    if (onlyInPhp.length || onlyInTs.length) diffs.push({ table, onlyInPhp, onlyInTs });
  }
  return diffs;
}

/** Confronto completo dei due DB di lavoro. */
export async function compareWorkingDatabases(opts: NormalizeOptions = {}): Promise<TableDiff[]> {
  const [php, ts] = await Promise.all([dumpDatabase(PHP_DB, opts), dumpDatabase(TS_DB, opts)]);
  return diffDumps(php, ts);
}

/** Esegue le stesse istruzioni SQL (con `{p}` = prefisso tabelle) su entrambi i DB di lavoro. */
export async function execBoth(...statements: string[]): Promise<void> {
  const conn = await connect();
  const prefix = installConfig().tablePrefix;
  try {
    for (const dbName of [PHP_DB, TS_DB]) {
      await conn.query(`USE \`${dbName}\``);
      for (const s of statements) await conn.query(s.replaceAll("{p}", prefix));
    }
  } finally {
    await conn.end();
  }
}
