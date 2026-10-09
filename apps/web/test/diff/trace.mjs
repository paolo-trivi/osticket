#!/usr/bin/env node
// Trace delle scritture del PHP: esegue un'operazione del runner su una copia del DB di sviluppo
// e stampa le righe aggiunte/rimosse/modificate tabella per tabella.
// Uso: node test/diff/trace.mjs '<json operazione>'   (es. '{"op":"ticket.note","args":{...}}')
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import mysql from "mysql2/promise";

const here = dirname(fileURLToPath(import.meta.url));
const cfgPath = process.env.OST_CONFIG_PATH ?? "/home/user/ost-dev/www/include/ost-config.php";
const php = Object.fromEntries([...readFileSync(cfgPath, "utf8").matchAll(/define\('([A-Z_]+)','([^']*)'\)/g)].map((m) => [m[1], m[2]]));
const SRC = php.DBNAME;
const TAG = process.env.OST_DIFF_TAG ? `_${process.env.OST_DIFF_TAG}` : "";
const BASE = `${SRC}_diff${TAG}_base`;
const WORK = `${SRC}_diff${TAG}_php`;
const prefix = php.TABLE_PREFIX;

const conn = await mysql.createConnection({ host: "127.0.0.1", user: php.DBUSER, password: php.DBPASS, dateStrings: true });
const tables = async (db) =>
  (await conn.query("SELECT table_name t FROM information_schema.tables WHERE table_schema=? AND table_type='BASE TABLE'", [db]))[0].map((r) => r.t);
async function clone(src, dst) {
  await conn.query(`DROP DATABASE IF EXISTS \`${dst}\``);
  await conn.query(`CREATE DATABASE \`${dst}\` DEFAULT CHARACTER SET utf8`);
  for (const t of await tables(src)) {
    await conn.query(`CREATE TABLE \`${dst}\`.\`${t}\` LIKE \`${src}\`.\`${t}\``);
    await conn.query(`INSERT INTO \`${dst}\`.\`${t}\` SELECT * FROM \`${src}\`.\`${t}\``);
  }
}
async function dump(db) {
  const out = {};
  for (const t of await tables(db)) {
    if (t === `${prefix}session`) continue;
    const [rows] = await conn.query(`SELECT * FROM \`${db}\`.\`${t}\``);
    out[t.slice(prefix.length)] = rows.map((r) =>
      JSON.stringify(r, (k, v) => (v && v.type === "Buffer" ? `<bin ${v.data.length}>` : v)),
    );
  }
  return out;
}

if (process.env.TRACE_FRESH !== "0") await clone(SRC, BASE);
await clone(BASE, WORK);
const before = await dump(WORK);
const sendmail = process.env.OST_SENDMAIL ?? `/home/user/ost-dev/bin/mailpit sendmail -S 127.0.0.1:${process.env.MAILPIT_SMTP_PORT ?? "1025"}`;
const out = execFileSync("php", ["-d", `sendmail_path=${sendmail}`, join(here, "php/runner.php"), process.env.OST_DIR ?? "/home/user/ost-dev/www", WORK, process.argv[2]], {
  encoding: "utf8",
});
console.log("PHP:", out.trim().split("\n").pop());
const after = await dump(WORK);
for (const t of Object.keys(after)) {
  const b = new Set(before[t] ?? []);
  const a = new Set(after[t]);
  const added = [...a].filter((r) => !b.has(r));
  const removed = [...b].filter((r) => !a.has(r));
  if (added.length || removed.length) {
    console.log(`\n=== ${t}`);
    for (const r of removed) console.log("  - " + r);
    for (const r of added) console.log("  + " + r);
  }
}
await conn.end();
