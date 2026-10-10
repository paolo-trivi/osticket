import { readFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db, type Tx } from "@/server/db";
import type { PhpVars } from "@/server/php/values";
import { sendTestEmail } from "@/server/domain/adminsys/email-test";
import { deleteLogs, listLogs } from "@/server/domain/adminsys/logs";
import { massPlugins } from "@/server/domain/adminsys/plugin";
import { massQueues, type QueueMassAction } from "@/server/domain/adminsys/queue";
import { systemInfo } from "@/server/domain/adminsys/system-info";

import { compareWorkingDatabases, execBoth, OST_ROOT, prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";
import { mailsOf } from "./lib/mailpit";

/** Code, log di sistema, plugin, diagnostica email e informazioni di sistema: PHP vs TypeScript. */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

type R = { ok: boolean; num?: number; error?: string | null; errors?: Record<string, string> };
const tx = <T>(fn: (t: Tx) => Promise<T>) => db().transaction().execute(fn);
const keys = (e?: Record<string, string>) => Object.keys(e ?? {}).sort();

describe("code: azioni di massa", () => {
  it("disattiva, riattiva, elimina (coda predefinita protetta)", async () => {
    const run = async (a: QueueMassAction, ids: number[]) => {
      const php = await runPhp<R>({ op: "adminsys.queue.mass", args: { agent: 1, a, ids: ids.map(String) } });
      const ts = await tx((t) => massQueues(t, a, ids));
      expect(ts.ok).toBe(php.ok);
      expect(ts.num).toBe(php.num);
      return { php, ts };
    };
    await run("disable", [1, 2, 3]);
    await run("enable", [2]);
    const del = await run("delete", [1, 4]);
    expect(del.php.error).toBe("default_queue");
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});

describe("log di sistema", () => {
  it("elenco con filtri ed eliminazione", async () => {
    await execBoth(
      "INSERT INTO {p}syslog (log_type, title, log, logger, ip_address, created, updated) VALUES ('Error', 'E1', 'x', '', '1.1.1.1', '2026-01-02 10:00:00', NOW()), ('Warning', 'W1', 'y', '', '1.1.1.1', '2026-02-02 10:00:00', NOW()), ('Debug', 'D1', 'z', '', '1.1.1.1', NOW(), NOW())",
    );
    const all = await listLogs(db(), {});
    expect(all.total).toBeGreaterThanOrEqual(3);
    const errors = await listLogs(db(), { type: "error", startDate: "2026-01-01", endDate: "2026-01-31" });
    expect(errors.rows.map((r) => r.title)).toEqual(["E1"]);
    const ids = all.rows.filter((r) => ["E1", "W1"].includes(r.title)).map((r) => r.log_id);
    const php = await runPhp<R>({ op: "adminsys.logs.delete", args: { agent: 1, ids: [...ids.map(String), "99999"] } });
    const ts = await tx((t) => deleteLogs(t, [...ids, 99999]));
    expect(ts.num).toBe(php.num);
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});

describe("plugin", () => {
  it("abilitazione e disabilitazione", async () => {
    await execBoth("INSERT INTO {p}plugin (id, name, install_path, isphar, isactive, version, installed) VALUES (1, 'Auth::LDAP', 'plugins/auth-ldap', 0, 0, '0.6', NOW()), (2, 'Storage::FS', 'plugins/storage-fs', 0, 1, '0.3', NOW())");
    for (const [a, ids] of [["enable", [1, 2]], ["disable", [2]]] as const) {
      await runPhp<R>({ op: "adminsys.plugins", args: { agent: 1, a, ids: ids.map(String) } });
      await tx((t) => massPlugins(t, a, [...ids]));
    }
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});

describe("diagnostica: email di prova (Mailpit)", () => {
  it("invio con l'email di sistema e cancellazione delle bozze email.diag", async () => {
    await execBoth("INSERT INTO {p}draft (id, staff_id, namespace, body, created) VALUES (70, 1, 'email.diag', 'x', NOW())");
    const vars: PhpVars = { email_id: "1", email: "dest@example.net", subj: "osTicket test email", body: "<p>Prova <b>invio</b><script>x</script></p>" };
    let php: R = { ok: false };
    let ts: R = { ok: false };
    const phpMails = await mailsOf(async () => (php = await runPhp<R>({ op: "adminsys.emailtest", args: { agent: 1, vars } })), 1);
    const tsMails = await mailsOf(async () => (ts = await tx((t) => sendTestEmail(t, vars))), 1);
    expect(php.ok).toBe(true);
    expect(ts.ok).toBe(true);
    expect(tsMails).toEqual(phpMails);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("errori: mittente, destinatario, oggetto e messaggio", async () => {
    const vars: PhpVars = { email_id: "0", email: "non-valida", subj: "", body: "" };
    const php = await runPhp<R>({ op: "adminsys.emailtest", args: { agent: 1, vars } });
    const ts = await tx((t) => sendTestEmail(t, vars));
    expect(ts.ok).toBe(false);
    expect(keys(ts.errors)).toEqual(keys(php.errors));
  });
});

describe("informazioni di sistema", () => {
  it("versione, database e fuso orario", async () => {
    const info = await systemInfo(db());
    // la versione dell'osTicket su cui gira l'harness (legacy/ o un'altra release, es. 1.17.8): da bootstrap.php
    const major = /define\('MAJOR_VERSION',\s*'([^']+)'\)/.exec(readFileSync(`${OST_ROOT}/bootstrap.php`, "utf8"))?.[1];
    expect(major).toMatch(/^1\.\d+$/);
    expect(info.osticketVersion?.startsWith(major ?? "?")).toBe(true);
    expect(info.dbVersion).toBeTruthy();
    expect(info.tablePrefix).toBe("ost_");
    expect(info.spaceUsedMiB).toBeGreaterThan(0);
  });
});
