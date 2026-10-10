import { createConnection } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db, type Tx } from "@/server/db";
import type { PhpVars } from "@/server/php/values";
import { massApiKeys, saveApiKey, type ApiKeyMassAction } from "@/server/domain/adminsys/apikey";
import { massPages, savePage, type PageMassAction } from "@/server/domain/adminsys/page";
import { installConfig } from "@/server/env";

import { compareWorkingDatabases, execBoth, PHP_DB, prepareSnapshot, resetWorkingDatabases, runPhp, TS_DB } from "./lib/harness";

/** API key (scp/apikeys.php) e pagine di contenuto (scp/pages.php): PHP vs TypeScript. */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

type R = { ok: boolean; id?: number | null; num?: number; error?: string | null; errors?: Record<string, string> };
const tx = <T>(fn: (t: Tx) => Promise<T>) => db().transaction().execute(fn);
const keys = (e?: Record<string, string>) => Object.keys(e ?? {}).sort();

async function both(op: string, id: number | null, vars: PhpVars, ts: (t: Tx) => Promise<R>): Promise<{ php: R; ts: R }> {
  const php = await runPhp<R>({ op, args: { agent: 1, id, vars } });
  const r = await tx(ts);
  if (process.env.DEBUG_DIFF) console.log(JSON.stringify({ php, ts: r }));
  expect(r.ok).toBe(php.ok);
  expect(keys(r.errors)).toEqual(keys(php.errors));
  if (php.ok && php.id) expect(r.id).toBe(php.id);
  return { php, ts: r };
}

/** La chiave è casuale: si verifica il formato e si copia quella del PHP nel DB TypeScript. */
async function alignApiKeys(): Promise<void> {
  const cfg = installConfig();
  const conn = await createConnection({ host: cfg.dbHost, port: cfg.dbPort, user: cfg.dbUser, password: cfg.dbPass });
  const t = `${cfg.tablePrefix}api_key`;
  try {
    const [php] = (await conn.query(`SELECT id, apikey FROM \`${PHP_DB}\`.${t} ORDER BY id`)) as unknown as [{ id: number; apikey: string }[]];
    const [ts] = (await conn.query(`SELECT id, apikey FROM \`${TS_DB}\`.${t} ORDER BY id`)) as unknown as [{ id: number; apikey: string }[]];
    expect(ts.map((r) => r.id)).toEqual(php.map((r) => r.id));
    for (const r of ts) expect(r.apikey).toMatch(/^[A-Z0-9]{48}$/);
    for (const r of php) await conn.query(`UPDATE \`${TS_DB}\`.${t} SET apikey = ? WHERE id = ?`, [r.apikey, r.id]);
  } finally {
    await conn.end();
  }
}

describe("API key: PHP vs TypeScript", () => {
  it("creazione, modifica, IP non valido, azioni di massa", async () => {
    const add = { do: "add", isactive: "1", ipaddr: "10.0.0.5", can_create_tickets: "1", notes: "<p>Key <script>x</script></p>" };
    const a = await both("adminsys.apikey", null, add, (t) => saveApiKey(t, null, add));
    expect(a.php.ok).toBe(true);
    const add2 = { do: "add", isactive: "0", ipaddr: "::1", can_exec_cron: "1" };
    const b = await both("adminsys.apikey", null, add2, (t) => saveApiKey(t, null, add2));
    await both("adminsys.apikey", null, { do: "add", isactive: "1", ipaddr: "300.1.1.1" }, (t) => saveApiKey(t, null, { do: "add", isactive: "1", ipaddr: "300.1.1.1" }));
    const upd = { do: "update", id: String(a.php.id), isactive: "0", ipaddr: "1.2.3.4", can_exec_cron: "1", notes: "" };
    await both("adminsys.apikey", a.php.id!, upd, (t) => saveApiKey(t, a.php.id!, upd));
    const ids = [a.php.id!, b.php.id!, 99];
    const run = async (action: ApiKeyMassAction, list: number[]) => {
      const php = await runPhp<R>({ op: "adminsys.apikey", args: { agent: 1, vars: { do: "mass_process", a: action, ids: list.map(String) } } });
      const ts = await tx((t) => massApiKeys(t, action, list));
      expect(ts.ok).toBe(php.ok);
      expect(ts.num).toBe(php.num);
    };
    await run("enable", ids);
    await run("enable", ids);
    await run("disable", [a.php.id!]);
    await run("delete", [b.php.id!, 99]);
    await alignApiKeys();
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});

const IMG = (key: string) => `<img src="cid:${key}" />`;

describe("pagine: PHP vs TypeScript", () => {
  it("creazione, modifica con immagini inline e bozze, errori di validazione", async () => {
    await execBoth(
      "INSERT INTO {p}file (id, ft, bk, type, size, `key`, signature, name, created) VALUES (50, 'T', 'D', 'image/png', 3, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'x', 'a.png', NOW()), (51, 'T', 'D', 'image/png', 3, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'y', 'b.png', NOW())",
      "INSERT INTO {p}draft (id, staff_id, namespace, body, created) VALUES (80, 1, 'page', 'x', NOW()), (81, 1, 'page.14.body', 'y', NOW()), (82, 1, 'page.3', 'z', NOW())",
      "INSERT INTO {p}attachment (object_id, type, file_id, inline) VALUES (81, 'D', 50, 1), (82, 'D', 51, 1)",
    );
    const add = { do: "add", id: "", type: "other", name: " Informativa <b>privacy</b> ", isactive: "1", body: `<p>Testo<script>x</script></p>${IMG("a".repeat(32))}`, notes: "n" };
    const p = await both("adminsys.page", null, add, (t) => savePage(t, null, add));
    expect(p.php.ok).toBe(true);
    const id = p.php.id!;
    const upd = { do: "update", id: String(id), type: "other", name: "Privacy", isactive: "0", body: `<p>Nuovo</p>${IMG("b".repeat(32))}${IMG("a".repeat(32))}`, notes: "" };
    await both("adminsys.page", id, upd, (t) => savePage(t, id, upd));
    await both("adminsys.page", id, { ...upd, body: "<p>x</p>" }, (t) => savePage(t, id, { ...upd, body: "<p>x</p>" }));
    // errori: pagina in uso non disattivabile, nome duplicato, campi obbligatori
    const landing = { do: "update", id: "1", type: "landing", name: "Landing", isactive: "0", body: "<p>x</p>" };
    await both("adminsys.page", 1, landing, (t) => savePage(t, 1, landing));
    const dup = { do: "add", type: "", name: "Landing", body: "" };
    await both("adminsys.page", null, dup, (t) => savePage(t, null, dup));
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("azioni di massa: pagine predefinite protette, usate da help topic, disattiva/attiva/elimina", async () => {
    await execBoth(
      "INSERT INTO {p}content (id, isactive, type, name, body, created, updated) VALUES (20, 1, 'other', 'A', 'a', NOW(), NOW()), (21, 0, 'other', 'B', 'b', NOW(), NOW()), (22, 1, 'other', 'C', 'c', NOW(), NOW())",
      "UPDATE {p}help_topic SET page_id = 22 WHERE topic_id = 2",
    );
    const run = async (action: PageMassAction, list: number[]) => {
      const php = await runPhp<R>({ op: "adminsys.page", args: { agent: 1, vars: { do: "mass_process", a: action, ids: list.map(String) } } });
      const ts = await tx((t) => massPages(t, action, list));
      expect(ts.ok).toBe(php.ok);
      expect(ts.num).toBe(php.num);
    };
    await run("disable", [1, 20]);
    await run("disable", [20, 21, 22]);
    await run("enable", [20, 21, 1]);
    await run("delete", [20, 22]);
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});
