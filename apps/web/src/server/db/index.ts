import "server-only";

import { CompiledQuery, Kysely, MysqlDialect, sql, type RawBuilder, type Transaction } from "kysely";
import { createPool, type Pool } from "mysql2";

import { installConfig } from "../env";
import type { DB } from "./schema.gen";
import { TablePrefixPlugin } from "./table-prefix-plugin";
import { withWriteGate } from "./write-gate";

export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;
/** Un esecutore di query: il DB o una transazione in corso. */
export type DbOrTx = Db | Tx;

/**
 * Variabili di sessione identiche a quelle impostate da osTicket in include/mysqli.php (db_connect):
 * stessa codifica, stesso SQL_MODE permissivo, stesso fuso. Servono perché le scritture della app
 * producano esattamente gli stessi valori di quelle del PHP (troncamenti, date zero, default impliciti).
 */
const SESSION_INIT =
  "SET NAMES utf8, CHARACTER SET utf8, SESSION COLLATION_CONNECTION = 'utf8_general_ci', " +
  "SESSION SQL_MODE = '', SESSION TIME_ZONE = 'SYSTEM'";

type GlobalWithDb = typeof globalThis & { __ostDb?: Db; __ostPool?: Pool };
const g = globalThis as GlobalWithDb;

function createDb(): Db {
  const cfg = installConfig();
  const pool = createPool({
    host: cfg.dbHost,
    port: cfg.dbPort,
    user: cfg.dbUser,
    password: cfg.dbPass,
    database: cfg.dbName,
    charset: "UTF8_GENERAL_CI",
    // I datetime restano stringhe nel fuso del DB: niente conversioni implicite di Node.
    dateStrings: true,
    supportBigNumbers: true,
    connectionLimit: Number(process.env.OST_DB_POOL ?? 10),
  });
  g.__ostPool = pool;

  return new Kysely<DB>({
    // gate delle scritture (TAILTICKET_MODE) e registro delle scritture: write-gate.ts
    dialect: withWriteGate(
      new MysqlDialect({
        pool,
        async onCreateConnection(connection) {
          await connection.executeQuery(CompiledQuery.raw(SESSION_INIT));
        },
      }),
    ),
    plugins: [new TablePrefixPlugin(cfg.tablePrefix)],
  });
}

export function db(): Db {
  g.__ostDb ??= createDb();
  return g.__ostDb;
}

/** Nome reale (con prefisso) di una tabella osTicket, per query sql`` scritte a mano. */
export function table(name: keyof DB | `${string}__cdata`): RawBuilder<unknown> {
  return sql.table(installConfig().tablePrefix + name);
}

/** Espressione SQL NOW(): il PHP valorizza created/updated lato SQL, nel fuso del server DB. */
export const NOW = sql<string>`NOW()`;

export async function closeDb(): Promise<void> {
  await g.__ostDb?.destroy();
  g.__ostDb = undefined;
  g.__ostPool = undefined;
}
