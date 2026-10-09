import { createConnection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfigNamespace } from "@/server/config/config";
import { closeDb, db } from "@/server/db";
import { loadClientIdentity } from "@/server/domain/client/identity";
import { openPortalTicket } from "@/server/domain/client/open";
import { uploadFile, uploadRules } from "@/server/domain/file/upload";
import { installConfig } from "@/server/env";

import { compareWorkingDatabases, execBoth, PHP_DB, prepareSnapshot, resetWorkingDatabases, runPhp, TS_DB } from "./lib/harness";
import { mailsOf as rawMailsOf } from "./lib/mailpit";

/**
 * Apertura di un ticket dal portale (open.php) con il servizio openPortalTicket: bozze della sessione,
 * Ticket::create 'Web' per cliente autenticato e ospite. PHP: op portal.open.
 */
const IP = "127.0.0.1";
const SESSION = "sessione-di-prova-abcdef123456";

beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

/** Il token dei link view.php?auth= contiene un hash della data di creazione (NOW() diverso) */
async function mailsOf(run: () => Promise<unknown>, expected: number) {
  const mails = await rawMailsOf(run, expected);
  return mails.map((m) => ({ ...m, html: m.html.replace(/(auth=[oc]\dx[a-z2-7]{13})[^"&\s<]*/g, "$1<SIG>") }));
}

const cfgSql = (key: string, value: string | number) =>
  `INSERT INTO {p}config (namespace, \`key\`, value, updated) VALUES ('core','${key}','${value}',NOW()) ON DUPLICATE KEY UPDATE value='${value}'`;
const SEQUENTIAL = cfgSql("ticket_sequence_id", 1);
const DRAFTS = [
  "INSERT INTO {p}draft (staff_id, namespace, body, created) VALUES (0, 'ticket.client.abcdef123456', 'bozza', NOW())",
  "INSERT INTO {p}draft (staff_id, namespace, body, created) VALUES (0, 'ticket.client.altrasession', 'altra', NOW())",
];

/** est_duedate dipende dall'istante di creazione: si confronta lo scarto rispetto a created */
async function compareAll(extraIgnore: string[] = []) {
  expect(await compareWorkingDatabases({ ignore: ["ticket.est_duedate", ...extraIgnore] })).toEqual([]);
  const cfg = installConfig();
  const conn = await createConnection({ host: cfg.dbHost, port: cfg.dbPort, user: cfg.dbUser, password: cfg.dbPass, dateStrings: true });
  try {
    const out: RowDataPacket[][] = [];
    for (const name of [PHP_DB, TS_DB]) {
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT ticket_id, TIMESTAMPDIFF(SECOND, created, est_duedate) AS due FROM \`${name}\`.${cfg.tablePrefix}ticket ORDER BY ticket_id`,
      );
      out.push(rows);
    }
    expect(out[1]).toEqual(out[0]);
  } finally {
    await conn.end();
  }
}

type Vars = Record<string, unknown>;
interface PhpResult {
  ok: boolean;
  id: number | null;
  number: string | null;
  errors: Record<string, unknown>;
}

const phpOpen = (client: number | null, vars: Vars, extra: Vars = {}) =>
  runPhp<PhpResult>({ op: "portal.open", args: { client, vars, session: SESSION, ...extra }, ip: IP });

async function tsOpen(client: number | null, vars: Vars) {
  const cfg = await loadConfigNamespace("core");
  const c = client ? await loadClientIdentity(client) : null;
  return openPortalTicket(cfg, c, vars, { ip: IP, sessionKey: SESSION });
}

describe("apertura dal portale (open.php)", () => {
  it("cliente autenticato con help topic: bozze della sessione eliminate, auto-risposta e avvisi", async () => {
    await execBoth(SEQUENTIAL, cfgSql("ticket_autoresponder", 1), ...DRAFTS);
    const vars = { topicId: 2, subject: "Monitor guasto", message: "<p>Il monitor della postazione 3 non si accende.</p>" };
    let php!: PhpResult;
    let ts: unknown;
    const phpMails = await mailsOf(async () => (php = await phpOpen(3, vars)), 2);
    const tsMails = await mailsOf(async () => (ts = await tsOpen(3, vars)), 2);
    expect(php.ok).toBe(true);
    expect(ts).toMatchObject({ ok: true, ticketId: php.id, number: php.number });
    await compareAll();
    expect(tsMails).toEqual(phpMails);
  });

  it("ospite con nuovo utente (registrazione pubblica)", async () => {
    await execBoth(SEQUENTIAL, cfgSql("verify_email_addrs", 0), ...DRAFTS);
    const vars = { email: "mario.verdi@paziente.example", name: "Mario Verdi", phone: "3331112222", topicId: 1, subject: "Richiesta informazioni", message: "<p>Buongiorno, vorrei informazioni.</p>" };
    const php = await phpOpen(null, vars);
    const ts = await tsOpen(null, vars);
    expect(php.ok).toBe(true);
    expect(ts).toMatchObject({ ok: true, ticketId: php.id });
    await compareAll();
  });

  it("errori di validazione: nessun ticket ma bozze comunque eliminate", async () => {
    await execBoth(cfgSql("verify_email_addrs", 0), ...DRAFTS);
    const vars = { topicId: 1, subject: "", message: "" };
    const php = await phpOpen(3, vars);
    const ts = await tsOpen(3, vars);
    expect(php.ok).toBe(false);
    expect(ts).toMatchObject({ ok: false });
    await compareAll();
  });

  it("allegato al messaggio", async () => {
    await execBoth(SEQUENTIAL);
    const php0 = await runPhp<{ ok: boolean; id: number }>({ op: "create.upload", args: { name: "referto.pdf", type: "application/pdf", data: Buffer.from("%PDF-1.4 referto").toString("base64") } });
    const ts0 = await uploadFile(db(), { name: "referto.pdf", type: "application/pdf", data: Buffer.from("%PDF-1.4 referto") }, uploadRules({}, await loadConfigNamespace("core")));
    expect(ts0.ok && ts0.file.id).toBe(php0.id);
    const vars = { topicId: 1, subject: "Referto", message: "<p>Allego il referto.</p>" };
    const php = await phpOpen(3, { ...vars, "attach:21": [`${php0.id},referto marzo.pdf`] }, { uploaded: { [php0.id]: "referto marzo.pdf" } });
    const ts = await tsOpen(3, { ...vars, files: [{ id: php0.id, name: "referto marzo.pdf" }] });
    expect(php.ok).toBe(true);
    expect(ts).toMatchObject({ ok: true, ticketId: php.id });
    await compareAll(["file.key"]);
  });

  it("solo clienti registrati (clients_only): ospite rifiutato senza scritture", async () => {
    await execBoth(cfgSql("clients_only", 1));
    expect(await tsOpen(null, { email: "x@paziente.example", name: "X", topicId: 1, subject: "a", message: "<p>b</p>" })).toEqual({ ok: false, denied: "login_required" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});
