import { createConnection } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { decrypt } from "@/server/crypto/crypto";
import { closeDb, db, type Tx } from "@/server/db";
import type { PhpVars } from "@/server/domain/admin/php";
import { massDeleteEmails, saveBasicAuth, saveEmail } from "@/server/domain/adminsys/email";
import { installConfig } from "@/server/env";

import { compareWorkingDatabases, execBoth, PHP_DB, prepareSnapshot, resetWorkingDatabases, runPhp, TS_DB } from "./lib/harness";

/** Account email (scp/emails.php, ajax.email.php): PHP vs TypeScript. SMTP di prova: Mailpit. */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

type R = { ok: boolean; id?: number | null; deleted?: number; num?: number; errors?: Record<string, string> };
const tx = <T>(fn: (t: Tx) => Promise<T>) => db().transaction().execute(fn);
const keys = (e?: Record<string, string>) => Object.keys(e ?? {}).sort();
const SMTP_PORT = process.env.MAILPIT_SMTP_PORT ?? "1025";

const BASE: PhpVars = {
  do: "update",
  id: "3",
  email: "noreply@example.com",
  name: "",
  dept_id: "1",
  priority_id: "2",
  topic_id: "0",
  notes: "",
  mailbox_active: "0",
  mailbox_host: "",
  mailbox_port: "",
  mailbox_protocol: "",
  mailbox_auth_bk: "",
  mailbox_fetchfreq: "5",
  mailbox_fetchmax: "30",
  mailbox_postfetch: "",
  mailbox_archivefolder: "",
  smtp_active: "0",
  smtp_host: "",
  smtp_port: "",
  smtp_auth_bk: "mailbox",
};

async function save(id: number | null, vars: PhpVars): Promise<{ php: R; ts: R }> {
  const php = await runPhp<R>({ op: "email.save", args: { agent: 1, id, vars } });
  const ts = await tx((t) => saveEmail(t, id, vars));
  if (process.env.DEBUG_DIFF) console.log(JSON.stringify({ php, ts }));
  expect(ts.ok).toBe(php.ok);
  expect(keys(ts.errors)).toEqual(keys(php.errors));
  if (php.ok) expect(ts.id).toBe(php.id);
  return { php, ts };
}

async function auth(id: number, type: "mailbox" | "smtp", vars: { username?: string; passwd?: string }, stash: PhpVars): Promise<{ php: R; ts: R }> {
  const php = await runPhp<R>({ op: "email.auth", args: { agent: 1, id, type, auth: "basic", vars, stash } });
  const ts = await tx((t) => saveBasicAuth(t, id, type, vars, stash));
  expect(ts.ok).toBe(php.ok);
  expect(keys(ts.errors)).toEqual(keys(php.errors));
  return { php, ts };
}

/**
 * Le password cifrate hanno un IV casuale: si verifica che entrambe si decifrino nella stessa
 * password e poi si copia il valore PHP nel DB TypeScript prima del confronto completo.
 */
async function alignPasswords(): Promise<number> {
  const cfg = installConfig();
  const conn = await createConnection({ host: cfg.dbHost, port: cfg.dbPort, user: cfg.dbUser, password: cfg.dbPass });
  const p = cfg.tablePrefix;
  try {
    const q = `SELECT namespace, value, (SELECT value FROM \`%db\`.${p}config u WHERE u.namespace = c.namespace AND u.\`key\` = 'username') AS username FROM \`%db\`.${p}config c WHERE c.namespace LIKE 'email.%' AND c.\`key\` = 'passwd' ORDER BY namespace`;
    const [php] = (await conn.query(q.replaceAll("%db", PHP_DB))) as unknown as [{ namespace: string; value: string; username: string }[]];
    const [ts] = (await conn.query(q.replaceAll("%db", TS_DB))) as unknown as [{ namespace: string; value: string; username: string }[]];
    expect(ts.map((r) => r.namespace)).toEqual(php.map((r) => r.namespace));
    const md5 = async (s: string) => (await import("node:crypto")).createHash("md5").update(s).digest("hex");
    // la chiave è md5(username . namespace dell'account), che può differire da quello in cui è salvata.
    // Con una chiave sbagliata AES-CBC supera il controllo del padding circa una volta su 256 e
    // restituisce byte casuali: si accetta solo il candidato con cui PHP e TS si decifrano nello
    // stesso testo stampabile.
    const PRINTABLE = /^[\x20-\x7e]+$/;
    for (let i = 0; i < php.length; i++) {
      const base = php[i].namespace.replace(/\d+$/, "");
      let match: string | null = null;
      for (let k = 0; k < 10 && match === null; k++) {
        const sub = await md5(php[i].username + base + k);
        const a = decrypt(php[i].value, cfg.secretSalt, sub);
        const b = decrypt(ts[i].value, cfg.secretSalt, sub);
        if (a !== false && b !== false && a === b && PRINTABLE.test(a)) match = a;
      }
      if (match === null) expect.fail(`password di ${php[i].namespace}: PHP e TS non si decifrano nello stesso testo`);
      await conn.query(`UPDATE \`${TS_DB}\`.${p}config SET value = ? WHERE namespace = ? AND \`key\` = 'passwd'`, [php[i].value, php[i].namespace]);
    }
    return php.length;
  } finally {
    await conn.end();
  }
}

describe("account email: PHP vs TypeScript", () => {
  it("creazione e errori di validazione dell'indirizzo e del nome", async () => {
    const add: PhpVars = { do: "create", id: "0", email: " helpdesk@example.net ", name: " Help <b>Desk</b> ", dept_id: "2", priority_id: "3", topic_id: "1", noautoresp: "1", notes: "<p>Note <script>x</script></p>" };
    const r = await save(null, add);
    expect(r.php.ok).toBe(true);
    await save(null, { ...add, email: "support@example.com" });
    await save(null, { ...add, email: "admin@example.com" });
    await save(null, { ...add, email: "mrossi@example.com" });
    await save(null, { ...add, email: "x@", name: "" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("modifica: crea gli account mailbox/SMTP inattivi, secondo salvataggio senza modifiche", async () => {
    await save(3, { ...BASE, name: "No Reply", notes: "nota" });
    await save(3, { ...BASE, name: "No Reply", notes: "nota" });
    await save(3, { ...BASE, name: "No Reply", id: "2" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("validazione mailbox e SMTP attivi senza autenticazione configurata", async () => {
    await save(3, { ...BASE, mailbox_active: "1", mailbox_fetchfreq: "", mailbox_fetchmax: "x", mailbox_protocol: "SMTP" });
    await save(3, { ...BASE, mailbox_active: "1", mailbox_host: "imap.example.net", mailbox_port: "993", mailbox_protocol: "POP", mailbox_folder: "INBOX", mailbox_auth_bk: "basic", mailbox_postfetch: "archive" });
    await save(3, { ...BASE, mailbox_postfetch: "archive", mailbox_folder: "INBOX", mailbox_archivefolder: "inbox" });
    await save(3, { ...BASE, smtp_active: "1", smtp_host: "", smtp_auth_bk: "" });
    await save(3, { ...BASE, smtp_active: "1", smtp_host: "127.0.0.1", smtp_port: SMTP_PORT, smtp_auth_bk: "mailbox" });
    await save(3, { ...BASE, smtp_auth_bk: "basic" });
    // archivio su IMAP inattivo: salvato
    await save(3, { ...BASE, mailbox_protocol: "IMAP", mailbox_postfetch: "archive", mailbox_folder: "INBOX", mailbox_archivefolder: "Archivio" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("autenticazione basic SMTP (Mailpit) e account SMTP attivo; SMTP senza autenticazione", async () => {
    await save(3, { ...BASE, name: "No Reply" });
    // bug PHP: con l'autenticazione SMTP salvata "mailbox" le credenziali vanno nel namespace della mailbox
    await auth(3, "smtp", { username: "relay", passwd: "segreta" }, { smtp_host: "127.0.0.1", smtp_port: SMTP_PORT });
    await save(3, { ...BASE, name: "No Reply", smtp_active: "1", smtp_host: "127.0.0.1", smtp_port: SMTP_PORT, smtp_auth_bk: "basic" });
    await save(3, { ...BASE, name: "No Reply", smtp_auth_bk: "none" });
    // errori del form: username e password obbligatori, poi protocollo/host
    await auth(3, "smtp", { username: "", passwd: "" }, {});
    await auth(3, "smtp", { username: "relay", passwd: "segreta" }, {});
    const ok = await auth(3, "smtp", { username: " relay ", passwd: "segreta" }, { smtp_host: "127.0.0.1", smtp_port: SMTP_PORT, smtp_active: "0" });
    expect(ok.php.ok).toBe(true);
    await save(3, { ...BASE, name: "No Reply", smtp_active: "1", smtp_host: "127.0.0.1", smtp_port: SMTP_PORT, smtp_auth_bk: "basic", smtp_allow_spoofing: "1" });
    // cambio password con le credenziali già salvate
    await auth(3, "smtp", { username: "relay2", passwd: "nuova" }, {});
    await save(3, { ...BASE, name: "No Reply", smtp_active: "1", smtp_host: "127.0.0.1", smtp_port: SMTP_PORT, smtp_auth_bk: "none" });
    // server irraggiungibile: errore smtp_auth, nessuna scrittura
    await save(3, { ...BASE, name: "No Reply", smtp_active: "1", smtp_host: "127.0.0.1", smtp_port: "1", smtp_auth_bk: "none" });
    expect(await alignPasswords()).toBe(2);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("autenticazione su account non ancora salvato (namespace account.0) e mailbox irraggiungibile", async () => {
    await auth(1, "smtp", { username: "relay", passwd: "pw" }, { smtp_host: "127.0.0.1", smtp_port: SMTP_PORT, smtp_protocol: "SMTP" });
    await auth(2, "mailbox", { username: "box", passwd: "pw" }, { mailbox_host: "127.0.0.1", mailbox_port: "1", mailbox_protocol: "IMAP" });
    expect(await alignPasswords()).toBe(1);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("eliminazione: account, credenziali e reparti; email predefinita e degli avvisi escluse", async () => {
    await save(3, { ...BASE, name: "No Reply", smtp_auth_bk: "none" });
    await auth(3, "smtp", { username: "relay", passwd: "segreta" }, { smtp_host: "127.0.0.1", smtp_port: SMTP_PORT });
    await execBoth("UPDATE {p}department SET email_id = 3 WHERE id = 2", "UPDATE {p}department SET autoresp_email_id = 3 WHERE id = 3");
    await alignPasswords();
    const php = await runPhp<R>({ op: "email.delete", args: { agent: 1, ids: ["1", "2", "3", "99"] } });
    const ts = await tx((t) => massDeleteEmails(t, [1, 2, 3, 99]));
    expect(ts.num).toBe(php.deleted);
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});
