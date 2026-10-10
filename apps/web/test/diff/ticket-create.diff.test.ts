import { createConnection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db } from "@/server/db";
import { createTicket, openTicket, type CreateResult } from "@/server/domain/ticket/create";
import { loadAgent } from "@/server/domain/staff/staff";
import { postNote, postReply } from "@/server/domain/ticket/post";
import { runWrite } from "@/server/domain/write";
import { installConfig } from "@/server/env";
import { loadConfigNamespace } from "@/server/config/config";
import { signUploadToken, uploadFile, uploadRules, verifyUploadTokens } from "@/server/domain/file/upload";
import { loadFormDef, loadTopicForms } from "@/server/domain/forms/load";
import { formDataToVars } from "@/server/domain/ticket/create-ui";

import { compareWorkingDatabases, execBoth, PHP_DB, prepareSnapshot, resetWorkingDatabases, runPhp, TS_DB } from "./lib/harness";
import { mailsOf as rawMailsOf } from "./lib/mailpit";

const IP = "127.0.0.1";

/**
 * Email normalizzate. Il token dei link `view.php?auth=` contiene un hash della data di creazione del
 * ticket (NOW() diverso tra le due esecuzioni): si confrontano solo il prefisso e gli id codificati.
 */
async function mailsOf(run: () => Promise<unknown>, expected: number) {
  const mails = await rawMailsOf(run, expected);
  return mails.map((m) => ({ ...m, html: m.html.replace(/(auth=[oc]\dx[a-z2-7]{13})[^"&\s<]*/g, "$1<SIG>") }));
}

beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

type Vars = Record<string, unknown>;
interface PhpResult {
  ok: boolean;
  id: number | null;
  number: string | null;
  errors: Record<string, unknown>;
}

async function tsOpen(agentId: number, vars: Vars): Promise<CreateResult> {
  const agent = await loadAgent(agentId, db());
  if (!agent) throw new Error("agente mancante");
  return runWrite({ agent, ip: IP }, (ctx) => openTicket(ctx, vars));
}

async function tsWeb(clientId: number | null, vars: Vars): Promise<CreateResult> {
  let actor = null;
  if (clientId) {
    const u = await db()
      .selectFrom("user as u")
      .innerJoin("user_email as e", "e.id", "u.default_email_id")
      .select(["u.id", "u.name", "e.address"])
      .where("u.id", "=", clientId)
      .executeTakeFirstOrThrow();
    const account = await db().selectFrom("user_account").select("id").where("user_id", "=", clientId).executeTakeFirst();
    actor = { kind: "user" as const, id: u.id, name: u.name, email: u.address, hasAccount: !!account, ip: IP };
  }
  return runWrite({ actor }, (ctx) => createTicket(ctx, { ...vars, ip: IP, uid: clientId ?? undefined, deptId: 0, emailId: 0 }, "web"));
}

const phpOpen = (agent: number, vars: Vars, extra: Vars = {}) => runPhp<PhpResult>({ op: "ticket.open", args: { agent, vars, ...extra } });
const phpWeb = (client: number | null, vars: Vars, extra: Vars = {}) => runPhp<PhpResult>({ op: "ticket.create.web", args: { client, vars, ...extra } });

/** Sequenza dei numeri (formato ######): numerazione deterministica su entrambi i DB */
const SEQUENTIAL = "INSERT INTO {p}config (namespace, `key`, value, updated) VALUES ('core','ticket_sequence_id','1',NOW()) ON DUPLICATE KEY UPDATE value='1'";

/** Stessa query sui due DB di lavoro (`{p}` = prefisso) */
async function queryBoth(query: string): Promise<[RowDataPacket[], RowDataPacket[]]> {
  const cfg = installConfig();
  const conn = await createConnection({ host: cfg.dbHost, port: cfg.dbPort, user: cfg.dbUser, password: cfg.dbPass, dateStrings: true });
  try {
    const out: RowDataPacket[][] = [];
    for (const name of [PHP_DB, TS_DB]) {
      const [rows] = await conn.query<RowDataPacket[]>(query.replaceAll("{p}", cfg.tablePrefix).replaceAll("{db}", name));
      out.push(rows);
    }
    return [out[0], out[1]];
  } finally {
    await conn.end();
  }
}

/**
 * Confronto completo dei DB. `est_duedate` dipende dall'istante di creazione (NOW() diverso tra le due
 * esecuzioni): si confronta lo scarto rispetto a `created`, identico se il calcolo SLA è lo stesso.
 */
async function compareAll(extraIgnore: string[] = []) {
  expect(await compareWorkingDatabases({ ignore: ["ticket.est_duedate", ...extraIgnore] })).toEqual([]);
  const [php, ts] = await queryBoth(
    "SELECT ticket_id, TIMESTAMPDIFF(SECOND, created, est_duedate) AS due FROM `{db}`.{p}ticket ORDER BY ticket_id",
  );
  // `duedate` (scelta dall'agente) è già confrontata in assoluto; per `est_duedate` lo scarto può
  // differire di 1 s se le due esecuzioni cadono a cavallo di un secondo tra NOW() e il calcolo SLA
  expect(ts.length).toEqual(php.length);
  ts.forEach((r, i) => {
    expect(r.ticket_id).toEqual(php[i].ticket_id);
    if (r.due === null || php[i].due === null) expect(r.due).toEqual(php[i].due);
    else expect(Math.abs(Number(r.due) - Number(php[i].due))).toBeLessThanOrEqual(1);
  });
}

function expectSameResult(php: PhpResult, ts: CreateResult) {
  expect(php).toMatchObject({ ok: true });
  expect(ts.ok ? ts : JSON.stringify(ts)).toMatchObject({ ok: true });
  if (ts.ok) {
    expect(ts.ticketId).toBe(php.id);
    expect(ts.number).toBe(php.number);
  }
}

const cfgSet = (key: string, value: string) =>
  `INSERT INTO {p}config (namespace, \`key\`, value, updated) VALUES ('core','${key}','${value}',NOW()) ON DUPLICATE KEY UPDATE value='${value}'`;

/** Filtro sui ticket Web con una regola e le azioni indicate ({type: configurazione}) */
function filterSql(id: number, rule: { what: string; how: string; val: string }, actions: [string, Record<string, unknown>][], opts: { stop?: boolean; all?: boolean; target?: string } = {}) {
  return [
    `INSERT INTO {p}filter (id, execorder, isactive, flags, status, match_all_rules, stop_onmatch, target, email_id, name, notes, created, updated)
      VALUES (${id}, ${id}, 1, 0, 0, ${opts.all ? 1 : 0}, ${opts.stop ? 1 : 0}, '${opts.target ?? "Web"}', 0, 'Filtro ${id}', '', NOW(), NOW())`,
    `INSERT INTO {p}filter_rule (filter_id, what, how, val, isactive, notes, created, updated) VALUES (${id}, '${rule.what}', '${rule.how}', '${rule.val}', 1, '', NOW(), NOW())`,
    ...actions.map(
      ([type, conf], i) => `INSERT INTO {p}filter_action (filter_id, sort, type, configuration, updated) VALUES (${id}, ${i + 1}, '${type}', '${JSON.stringify(conf)}', NOW())`,
    ),
  ];
}

/** Carica lo stesso file su entrambi i DB (create.upload in PHP, uploadFile in TS) */
async function uploadBoth(name: string, type: string, data: Buffer): Promise<number> {
  const php = await runPhp<{ ok: boolean; id: number }>({ op: "create.upload", args: { name, type, data: data.toString("base64") } });
  const ts = await uploadFile(db(), { name, type, data }, uploadRules({}, await loadConfigNamespace("core")));
  expect(php.ok).toBe(true);
  expect(ts.ok && ts.file.id).toBe(php.id);
  return php.id;
}

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000100e221bc330000000049454e44ae426082",
  "hex",
);

describe("apertura da agente (scp/tickets.php?a=open → Ticket::open)", () => {
  it("utente esistente, topic, telefono: alert all'admin e notice al cliente", async () => {
    await execBoth(SEQUENTIAL);
    const vars = { uid: 2, source: "Phone", topicId: 1, subject: "Monitor guasto in radiologia", message: "<p>Il monitor della sala 2 non si accende.</p>", "reply-to": "all" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(async () => (php = await phpOpen(2, vars)), 2);
    const tsMails = await mailsOf(async () => (ts = await tsOpen(2, vars)), 2);
    expectSameResult(php, ts);
    await compareAll();
    expect(phpMails.length).toBe(2);
    expect(tsMails).toEqual(phpMails);
  });

  it("nuovo utente (nome, email, telefono) creato dall'agente", async () => {
    await execBoth(SEQUENTIAL, cfgSet("verify_email_addrs", "0"));
    const vars = { email: "nuovo.paziente@clinica.example", name: "Rossi, Mario", phone: "0612345678", source: "Email", topicId: 2, subject: "Richiesta referto", message: "<p>Vorrei il referto dell'esame.</p>", "reply-to": "user" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(async () => (php = await phpOpen(2, vars)), 2);
    const tsMails = await mailsOf(async () => (ts = await tsOpen(2, vars)), 2);
    expectSameResult(php, ts);
    await compareAll();
    expect(tsMails).toEqual(phpMails);
  });

  it("agente senza permesso user.create: errore e nessuna scrittura", async () => {
    await execBoth(SEQUENTIAL, cfgSet("verify_email_addrs", "0"));
    const vars = { email: "altro@clinica.example", name: "Altro Utente", source: "Phone", topicId: 1, subject: "Prova", message: "<p>Prova</p>" };
    const php = await phpOpen(3, vars);
    const ts = await tsOpen(3, vars);
    expect(php.ok).toBe(false);
    expect(ts.ok).toBe(false);
    expect(php.errors.user).toBe("You do not have permission to create users.");
    if (!ts.ok) expect(ts.errors.user).toBe(php.errors.user);
    await compareAll();
  });

  it("risposta iniziale con notifica ticket.notice (risposta inclusa) e firma del reparto", async () => {
    await execBoth(SEQUENTIAL, "UPDATE {p}department SET signature='<p>Reparto Assistenza</p>' WHERE id=1");
    const vars = { uid: 5, source: "Phone", topicId: 1, deptId: 1, subject: "Badge non funzionante", message: "<p>Il badge non apre la porta.</p>", response: "<p>Abbiamo riattivato il badge.</p>", signature: "dept", "reply-to": "all" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(async () => (php = await phpOpen(2, vars)), 2);
    const tsMails = await mailsOf(async () => (ts = await tsOpen(2, vars)), 2);
    expectSameResult(php, ts);
    await compareAll();
    expect(tsMails).toEqual(phpMails);
  });

  it("risposta iniziale senza ticket.notice: email della risposta al cliente", async () => {
    await execBoth(SEQUENTIAL, cfgSet("ticket_notice_active", "0"));
    const vars = { uid: 6, source: "Other", topicId: 1, subject: "Cambio turno", message: "<p>Richiesta cambio turno.</p>", response: "<p>Fatto.</p>", "reply-to": "all" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(async () => (php = await phpOpen(2, vars)), 2);
    const tsMails = await mailsOf(async () => (ts = await tsOpen(2, vars)), 2);
    expectSameResult(php, ts);
    await compareAll();
    expect(tsMails).toEqual(phpMails);
  });

  it("nota interna iniziale, nessuna notifica (reply-to none), bozze 'ticket.staff%' eliminate", async () => {
    await execBoth(
      SEQUENTIAL,
      "INSERT INTO {p}draft (staff_id, namespace, body, extra, created, updated) VALUES (2, 'ticket.staff.open', '<p>bozza</p>', NULL, NOW(), NOW()), (2, 'ticket.response.3', '<p>altra</p>', NULL, NOW(), NOW()), (3, 'ticket.staff.open', '<p>di altri</p>', NULL, NOW(), NOW())",
    );
    const vars = { uid: 7, source: "Phone", topicId: 1, subject: "Guasto stampante", message: "<p>La stampante del piano 3 è bloccata.</p>", note: "<p>Chiamare il fornitore.</p>", "reply-to": "none" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(async () => (php = await phpOpen(2, vars)), 1);
    const tsMails = await mailsOf(async () => (ts = await tsOpen(2, vars)), 1);
    expectSameResult(php, ts);
    await compareAll();
    expect(tsMails).toEqual(phpMails);
  });

  it("assegnazione a un agente con commenti: nota e assigned.alert", async () => {
    await execBoth(SEQUENTIAL);
    const vars = { uid: 8, source: "Phone", topicId: 1, subject: "Rete lenta", message: "<p>La rete è lenta in cardiologia.</p>", assignId: "s3", note: "<p>Verifica lo switch.</p>", "reply-to": "all" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(async () => (php = await phpOpen(2, vars)), 3);
    const tsMails = await mailsOf(async () => (ts = await tsOpen(2, vars)), 3);
    expectSameResult(php, ts);
    await compareAll();
    expect(tsMails).toEqual(phpMails);
  });

  it("assegnazione a sé stessi (claim) e a un team", async () => {
    await execBoth(SEQUENTIAL);
    for (const assignId of ["s2", "t1"]) {
      const vars = { uid: 9, source: "Phone", topicId: 1, subject: `Assegnato ${assignId}`, message: "<p>Testo</p>", assignId, "reply-to": "none" };
      expectSameResult(await phpOpen(2, vars), await tsOpen(2, vars));
    }
    await compareAll();
  });

  it("reparto, priorità, SLA e scadenza scelti dall'agente", async () => {
    await execBoth(SEQUENTIAL);
    const vars = { uid: 10, source: "Phone", topicId: 1, deptId: 2, priority: 4, slaId: 1, duedate: "2030-03-15 14:30", subject: "Ordine urgente", message: "<p>Serve un ordine urgente.</p>", "reply-to": "none" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(async () => (php = await phpOpen(2, vars)), 1);
    const tsMails = await mailsOf(async () => (ts = await tsOpen(2, vars)), 1);
    expectSameResult(php, ts);
    await compareAll();
    expect(tsMails).toEqual(phpMails);
  });

  it("stato iniziale chiuso", async () => {
    await execBoth(SEQUENTIAL);
    const vars = { uid: 11, source: "Phone", topicId: 1, statusId: 3, subject: "Già risolto", message: "<p>Risolto al telefono.</p>", "reply-to": "none" };
    expectSameResult(await phpOpen(2, vars), await tsOpen(2, vars));
    await compareAll();
  });

  it("topic figlio con SLA e priorità propri", async () => {
    await execBoth(SEQUENTIAL);
    const vars = { uid: 12, source: "Phone", topicId: 11, subject: "Accesso negato", message: "<p>Non riesco ad accedere.</p>", "reply-to": "none" };
    expectSameResult(await phpOpen(2, vars), await tsOpen(2, vars));
    await compareAll();
  });

  it("oggetto obbligatorio mancante e sorgente non valida: errori, nessuna scrittura", async () => {
    await execBoth(SEQUENTIAL);
    const vars = { uid: 12, source: "Phone", topicId: 11, subject: "", message: "<p>Testo</p>" };
    const php = await phpOpen(2, vars);
    const ts = await tsOpen(2, vars);
    expect(php.ok).toBe(false);
    expect(ts.ok).toBe(false);
    if (!ts.ok) expect(Object.keys(ts.errors.fields ?? {})).toEqual(Object.keys(php.errors).filter((k) => /^\d+$/.test(k)));
    const bad = { ...vars, subject: "Ok", source: "Fax" };
    const php2 = await phpOpen(2, bad);
    const ts2 = await tsOpen(2, bad);
    expect(php2.ok || ts2.ok).toBe(false);
    if (!ts2.ok) expect(ts2.errors.source).toBe(php2.errors.source);
    await compareAll();
  });

  it("collaboratori in cc: evento collab e notice con Cc", async () => {
    await execBoth(SEQUENTIAL);
    const vars = { uid: 2, ccs: [3, 4], source: "Phone", topicId: 1, subject: "Con colleghi", message: "<p>Mettere in copia i colleghi.</p>", "reply-to": "all" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(async () => (php = await phpOpen(2, vars)), 2);
    const tsMails = await mailsOf(async () => (ts = await tsOpen(2, vars)), 2);
    expectSameResult(php, ts);
    await compareAll();
    expect(tsMails).toEqual(phpMails);
  });

  it("allegati del messaggio e della risposta iniziale", async () => {
    await execBoth(SEQUENTIAL);
    const f1 = await uploadBoth("referto.pdf", "application/pdf", Buffer.from("%PDF-1.4 referto di prova"));
    const f2 = await uploadBoth("foto.png", "image/png", PNG);
    const vars = { uid: 3, source: "Phone", topicId: 1, subject: "Con allegati", message: "<p>Vedi allegato.</p>", response: "<p>Ecco la foto.</p>", "reply-to": "all" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(
      async () => (php = await phpOpen(2, { ...vars, "attach:21": [`${f1},referto.pdf`] }, { uploaded: { [f1]: "referto.pdf", [f2]: "foto.png" }, responseFiles: [{ id: f2, name: "foto.png" }] })),
      2,
    );
    const tsMails = await mailsOf(async () => (ts = await tsOpen(2, { ...vars, files: [{ id: f1, name: "referto.pdf" }], responseFiles: [{ id: f2, name: "foto.png" }] })), 2);
    expectSameResult(php, ts);
    await compareAll(["file.key"]);
    expect(tsMails).toEqual(phpMails);
  });
});

describe("numerazione", () => {
  it("topic con numerazione personalizzata (sequenza e formato del topic)", async () => {
    await execBoth(SEQUENTIAL, "UPDATE {p}help_topic SET flags = flags | 1, sequence_id = 2, number_format = 'MNT-####' WHERE topic_id = 10");
    const vars = { uid: 4, source: "Phone", topicId: 10, subject: "Perdita d'acqua", message: "<p>Perdita nel bagno.</p>", "reply-to": "none" };
    const php = await phpOpen(2, vars);
    const ts = await tsOpen(2, vars);
    expectSameResult(php, ts);
    expect(php.number).toBe("MNT-0013");
    await compareAll();
  });

  it("formato casuale (nessuna sequenza): numero di 6 cifre", async () => {
    const vars = { uid: 4, source: "Phone", topicId: 1, subject: "Numero casuale", message: "<p>Testo</p>", "reply-to": "none" };
    const php = await phpOpen(2, vars);
    const ts = await tsOpen(2, vars);
    expect(php.ok && ts.ok).toBe(true);
    expect(php.number).toMatch(/^[1-9]\d{5}$/);
    if (ts.ok) expect(ts.number).toMatch(/^[1-9]\d{5}$/);
    // il numero compare anche nel titolo dell'indice di ricerca
    await compareAll(["ticket.number", "_search.title"]);
    const [p, t] = await queryBoth("SELECT S.title = CONCAT(T.number, ' Numero casuale') AS ok FROM `{db}`.{p}_search S JOIN `{db}`.{p}ticket T ON (T.ticket_id = S.object_id) WHERE S.object_type = 'T' AND T.ticket_id = 62");
    expect([p[0]?.ok, t[0]?.ok]).toEqual([1, 1]);
  });
});

describe("filtri (ticket-filter)", () => {
  it("instradamento: reparto, priorità, SLA, agente, team, stato e topic", async () => {
    await execBoth(
      SEQUENTIAL,
      ...filterSql(10, { what: "email", how: "ends", val: "ospedale.example" }, [
        ["dept", { dept_id: 3 }],
        ["pri", { priority: 3 }],
        ["sla", { sla_id: 1 }],
        ["agent", { staff_id: 3 }],
        ["team", { team_id: 1 }],
      ]),
      ...filterSql(11, { what: "field.20", how: "contains", val: "urgente" }, [
        ["topic", { topic_id: 10 }],
        ["status", { status_id: 1 }],
        ["noresp", {}],
      ]),
    );
    const vars = { uid: 2, source: "Phone", topicId: 1, subject: "Intervento URGENTE", message: "<p>Testo</p>", "reply-to": "all" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(async () => (php = await phpOpen(2, vars)), 3);
    const tsMails = await mailsOf(async () => (ts = await tsOpen(2, vars)), 3);
    expectSameResult(php, ts);
    await compareAll();
    expect(tsMails).toEqual(phpMails);
  });

  it("stop on match: si applica solo il primo filtro", async () => {
    await execBoth(
      SEQUENTIAL,
      ...filterSql(10, { what: "name", how: "contains", val: "Romano" }, [["dept", { dept_id: 2 }]], { stop: true }),
      ...filterSql(11, { what: "name", how: "contains", val: "Francesca" }, [["dept", { dept_id: 3 }]]),
    );
    const vars = { uid: 2, source: "Phone", topicId: 1, subject: "Stop", message: "<p>Testo</p>", "reply-to": "none" };
    expectSameResult(await phpOpen(2, vars), await tsOpen(2, vars));
    await compareAll();
  });

  it("filtro di rifiuto: errore 403 e log di sistema", async () => {
    await execBoth(...filterSql(10, { what: "field.20", how: "match", val: "/spam/i" }, [["reject", {}]], { target: "Any" }));
    const vars = { uid: 2, source: "Phone", topicId: 1, subject: "Offerta SPAM", message: "<p>Testo</p>" };
    const php = await phpOpen(2, vars);
    const ts = await tsOpen(2, vars);
    expect(php.ok).toBe(false);
    expect(ts.ok).toBe(false);
    if (!ts.ok) expect(ts.errors).toMatchObject({ errno: 403, err: php.errors.err });
    await compareAll(["syslog.log_id"]);
  });
});

describe("apertura dal portale (open.php → Ticket::create 'Web')", () => {
  it("cliente autenticato: auto-risposta ticket.autoresp e alert", async () => {
    await execBoth(SEQUENTIAL, cfgSet("ticket_autoresponder", "1"));
    const vars = { topicId: 2, subject: "Suggerimento", message: "<p>Propongo orari più ampi.</p>" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(async () => (php = await phpWeb(3, vars)), 2);
    const tsMails = await mailsOf(async () => (ts = await tsWeb(3, vars)), 2);
    expectSameResult(php, ts);
    await compareAll();
    expect(phpMails.length).toBe(2);
    expect(tsMails).toEqual(phpMails);
  });

  it("ospite con nuovo utente: utente, email, form Contact Information, indice", async () => {
    await execBoth(SEQUENTIAL, cfgSet("verify_email_addrs", "0"), cfgSet("ticket_autoresponder", "1"));
    const vars = { email: "giulia.neri@paziente.example", name: "Giulia Neri", phone: "333 1234567", topicId: 1, subject: "Prenotazione", message: "<p>Vorrei prenotare una visita.</p>" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(async () => (php = await phpWeb(null, vars)), 2);
    const tsMails = await mailsOf(async () => (ts = await tsWeb(null, vars)), 2);
    expectSameResult(php, ts);
    await compareAll();
    expect(tsMails).toEqual(phpMails);
  });

  it("ospite con email di un utente esistente", async () => {
    await execBoth(SEQUENTIAL);
    const vars = { email: "f.romano@ospedale.example", name: "Altro Nome", topicId: 1, subject: "Ospite noto", message: "<p>Testo</p>" };
    expectSameResult(await phpWeb(null, vars), await tsWeb(null, vars));
    await compareAll();
  });

  it("email nella ban list: rifiutato", async () => {
    await execBoth(cfgSet("verify_email_addrs", "0"));
    const vars = { email: "test@example.com", name: "Bannato", topicId: 1, subject: "Ban", message: "<p>Testo</p>" };
    const php = await phpWeb(null, vars);
    const ts = await tsWeb(null, vars);
    expect(php.ok).toBe(false);
    expect(ts.ok).toBe(false);
    await compareAll(["syslog.log_id"]);
  });

  it("campi obbligatori mancanti: errori, nessuna scrittura", async () => {
    await execBoth(cfgSet("verify_email_addrs", "0"));
    const vars = { email: "x@paziente.example", name: "", topicId: 1, subject: "", message: "" };
    const php = await phpWeb(null, vars);
    const ts = await tsWeb(null, vars);
    expect(php.ok).toBe(false);
    expect(ts.ok).toBe(false);
    await compareAll();
  });

  it("limite di ticket aperti superato: rifiutato con log", async () => {
    await execBoth(cfgSet("max_open_tickets", "1"));
    const vars = { topicId: 1, subject: "Troppi", message: "<p>Testo</p>" };
    const php = await phpWeb(2, vars);
    const ts = await tsWeb(2, vars);
    expect(php.ok).toBe(false);
    expect(ts.ok).toBe(false);
    if (!ts.ok) expect(ts.errors.err).toBe(php.errors.err);
    await compareAll(["syslog.log_id"]);
  });

  it("limite di ticket aperti raggiunto: onOpenLimit con avviso ticket.overlimit", async () => {
    await execBoth(SEQUENTIAL, cfgSet("verify_email_addrs", "0"), cfgSet("max_open_tickets", "1"), cfgSet("overlimit_notice_active", "1"), cfgSet("ticket_autoresponder", "1"));
    const vars = { email: "limite@paziente.example", name: "Utente Limite", topicId: 1, subject: "Primo", message: "<p>Testo</p>" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(async () => (php = await phpWeb(null, vars)), 5);
    const tsMails = await mailsOf(async () => (ts = await tsWeb(null, vars)), 5);
    expectSameResult(php, ts);
    expect(phpMails.map((m) => m.subject)).toContain("Overlimit Notice");
    await compareAll(["syslog.log_id"]);
    expect(tsMails).toEqual(phpMails);
  });

  it("allegato al messaggio dal portale", async () => {
    await execBoth(SEQUENTIAL);
    const f1 = await uploadBoth("modulo%20firmato.pdf", "application/pdf", Buffer.from("%PDF-1.4 modulo"));
    const vars = { topicId: 1, subject: "Modulo", message: "<p>In allegato il modulo.</p>" };
    const php = await phpWeb(4, { ...vars, "attach:21": [`${f1},modulo firmato.pdf`] }, { uploaded: { [f1]: "modulo firmato.pdf" } });
    const ts = await tsWeb(4, { ...vars, files: [{ id: f1, name: "modulo firmato.pdf" }] });
    expectSameResult(php, ts);
    await compareAll(["file.key"]);
  });
});

/** Form personalizzato (tipo G) collegato al topic 2 e campo extra nel form dei ticket con colonna cdata */
const CUSTOM_FORMS = [
  "INSERT INTO {p}list (id, name, name_plural, sort_mode, masks, type, configuration, notes, created, updated) VALUES (2, 'Reparti', 'Reparti', 'Alpha', 0, NULL, '', '', NOW(), NOW())",
  "INSERT INTO {p}list_items (id, list_id, status, value, extra, sort, properties) VALUES (20, 2, 1, 'Radiologia', NULL, 1, '[]'), (21, 2, 1, 'Cardiologia', NULL, 2, '[]'), (22, 2, 0, 'Chiuso', NULL, 3, '[]')",
  "INSERT INTO {p}form (id, pid, type, flags, title, instructions, name, notes, created, updated) VALUES (10, NULL, 'G', 1, 'Dettagli tecnici', '', '', '', NOW(), NOW())",
  `INSERT INTO {p}form_field (id, form_id, flags, type, label, name, configuration, sort, hint, created, updated) VALUES
    (100, 10, 13057, 'text', 'Seriale', 'seriale', '{"size":20,"length":30}', 1, '', NOW(), NOW()),
    (101, 10, 13057, 'memo', 'Descrizione', 'descrizione', '{"rows":3,"cols":40,"html":false}', 2, '', NOW(), NOW()),
    (102, 10, 14081, 'choices', 'Urgenza', 'urgenza', '{"choices":"a:Alta\\\\nb:Bassa","multiselect":false}', 3, '', NOW(), NOW()),
    (103, 10, 13057, 'bool', 'In garanzia', 'garanzia', '{"desc":"Coperto da garanzia"}', 4, '', NOW(), NOW()),
    (104, 10, 13057, 'datetime', 'Data guasto', 'data_guasto', '{"time":false}', 5, '', NOW(), NOW()),
    (105, 10, 13057, 'phone', 'Telefono reparto', 'tel', '{"ext":true}', 6, '', NOW(), NOW()),
    (106, 10, 13057, 'list-2', 'Reparto', 'reparto', '{"multiselect":false}', 7, '', NOW(), NOW()),
    (107, 10, 13057, 'text', 'Senza nome', '', '{}', 8, '', NOW(), NOW()),
    (108, 10, 12289, 'text', 'Solo agenti', 'interno', '{}', 9, '', NOW(), NOW())`,
  "INSERT INTO {p}help_topic_form (topic_id, form_id, sort, extra) VALUES (2, 10, 2, '{\"disable\":[]}')",
  `INSERT INTO {p}form_field (id, form_id, flags, type, label, name, configuration, sort, hint, created, updated) VALUES
    (110, 2, 13057, 'choices', 'Area', 'area', '{"choices":"n:Nord\\\\ns:Sud","multiselect":true}', 4, '', NOW(), NOW())`,
  "ALTER TABLE {p}ticket__cdata ADD COLUMN area mediumtext",
];

describe("form dinamici del topic e campi cdata", () => {
  it("portale: form personalizzato del topic, campo extra del ticket (cdata), indice", async () => {
    await execBoth(SEQUENTIAL, ...CUSTOM_FORMS);
    const vars = {
      topicId: 2,
      subject: "Guasto ecografo",
      message: "<p>L'ecografo non si avvia.</p>",
      seriale: "SN-<b>778</b>",
      descrizione: "  Errore E42 all'accensione  ",
      urgenza: "a",
      garanzia: "1",
      data_guasto: "2026-09-30",
      tel: "06 5551234",
      reparto: "21",
      "107": "Valore per id",
      area: ["n", "s"],
    };
    expectSameResult(await phpWeb(5, vars), await tsWeb(5, vars));
    await compareAll();
  });

  it("portale: campo visibile solo agli agenti ignorato (regola più stretta del PHP)", async () => {
    await execBoth(SEQUENTIAL, ...CUSTOM_FORMS);
    const vars = { topicId: 2, subject: "Campo interno", message: "<p>Testo</p>", urgenza: "a", interno: "valore inviato dal cliente" };
    expectSameResult(await phpWeb(5, vars), await tsWeb(5, vars));
    // Bug PHP non replicato (permessi): open.php accetta anche i campi non visibili ai clienti
    const [php, ts] = await queryBoth("SELECT value FROM `{db}`.{p}form_entry_values WHERE field_id = 108");
    expect(php).toEqual([{ value: "valore inviato dal cliente" }]);
    expect(ts).toEqual([{ value: null }]);
    await execBoth("UPDATE {p}form_entry_values SET value = NULL WHERE field_id = 108");
    await compareAll(["_search.content"]);
  });

  it("agente: form del topic con campo solo agenti e priorità dal form", async () => {
    await execBoth(SEQUENTIAL, ...CUSTOM_FORMS);
    const vars = { uid: 6, source: "Phone", topicId: 2, priority: 1, subject: "Da agente", message: "<p>Testo</p>", urgenza: "b", interno: "nota interna", garanzia: "", "reply-to": "none" };
    expectSameResult(await phpOpen(2, vars), await tsOpen(2, vars));
    await compareAll();
  });

  it("portale: campo obbligatorio del topic mancante → errore", async () => {
    await execBoth(SEQUENTIAL, ...CUSTOM_FORMS);
    const vars = { topicId: 2, subject: "Senza urgenza", message: "<p>Testo</p>" };
    const php = await phpWeb(5, vars);
    const ts = await tsWeb(5, vars);
    expect(php.ok).toBe(false);
    expect(ts.ok).toBe(false);
    if (!ts.ok) expect(Object.keys(ts.errors.fields ?? {})).toEqual(["102"]);
    await compareAll();
  });

  it("risposte vuote inviate dal form: NULL come il PHP (ticket, topic e nuovo utente)", async () => {
    await execBoth(SEQUENTIAL, cfgSet("verify_email_addrs", "0"), ...CUSTOM_FORMS);
    const vars = {
      source: "Phone",
      topicId: 2,
      email: "campi.vuoti@paziente.example",
      name: "Campi Vuoti",
      phone: "",
      notes: "",
      subject: "Campi vuoti",
      message: "<p>Testo</p>",
      seriale: "",
      descrizione: "",
      urgenza: "a",
      garanzia: "",
      data_guasto: "",
      tel: "",
      reparto: "",
      "107": "",
      interno: "",
      area: [],
      "reply-to": "none",
    };
    expectSameResult(await phpOpen(2, vars), await tsOpen(2, vars));
    await compareAll();
  });

  it("valori grezzi come il PHP: telefono di soli spazi non valido, data \"0\" non convertita", async () => {
    await execBoth(SEQUENTIAL, cfgSet("verify_email_addrs", "0"), ...CUSTOM_FORMS);
    const spaces = { email: "spazi@paziente.example", name: "Solo Spazi", phone: "   ", topicId: 1, subject: "Telefono", message: "<p>Testo</p>" };
    const php = await phpWeb(null, spaces);
    const ts = await tsWeb(null, spaces);
    expect(php.ok).toBe(false);
    expect(ts.ok).toBe(false);
    const zero = { topicId: 2, subject: "Data zero", message: "<p>Testo</p>", urgenza: "b", data_guasto: "0" };
    expectSameResult(await phpWeb(5, zero), await tsWeb(5, zero));
    await compareAll();
  });

  it("campo disattivato dal topic: non salvato e escluso dalla validazione", async () => {
    await execBoth(SEQUENTIAL, ...CUSTOM_FORMS, "UPDATE {p}help_topic_form SET extra='{\"disable\":[102,103]}' WHERE topic_id=2 AND form_id=10");
    const vars = { topicId: 2, subject: "Disattivati", message: "<p>Testo</p>", seriale: "X1" };
    expectSameResult(await phpWeb(5, vars), await tsWeb(5, vars));
    await compareAll();
  });
});

describe("assegnazione automatica, organizzazioni, reparti", () => {
  it("topic con agente e SLA predefiniti, senza auto-risposta", async () => {
    await execBoth(SEQUENTIAL, cfgSet("ticket_autoresponder", "1"), "UPDATE {p}help_topic SET staff_id=3, noautoresp=1, sla_id=1 WHERE topic_id=1");
    const vars = { topicId: 1, subject: "Auto-assegnato", message: "<p>Testo</p>" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(async () => (php = await phpWeb(7, vars)), 2);
    const tsMails = await mailsOf(async () => (ts = await tsWeb(7, vars)), 2);
    expectSameResult(php, ts);
    await compareAll();
    expect(tsMails).toEqual(phpMails);
  });

  it("topic con team predefinito; agente in vacanza non assegnabile", async () => {
    await execBoth(SEQUENTIAL, "UPDATE {p}help_topic SET team_id=1 WHERE topic_id=10", "UPDATE {p}help_topic SET staff_id=4 WHERE topic_id=2", "UPDATE {p}staff SET onvacation=1 WHERE staff_id=4");
    for (const topicId of [10, 2]) {
      const vars = { topicId, subject: `Topic ${topicId}`, message: "<p>Testo</p>" };
      expectSameResult(await phpWeb(8, vars), await tsWeb(8, vars));
    }
    await compareAll();
  });

  it("organizzazione: collaboratori automatici e account manager", async () => {
    await execBoth(
      SEQUENTIAL,
      cfgSet("ticket_alert_acct_manager", "1"),
      "UPDATE {p}organization SET status = status | 1 | 4, manager = 's5' WHERE id = 2",
      "UPDATE {p}user SET status = 1 WHERE id = 7",
    );
    const vars = { topicId: 1, subject: "Org", message: "<p>Testo</p>" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(async () => (php = await phpWeb(2, vars)), 2);
    const tsMails = await mailsOf(async () => (ts = await tsWeb(2, vars)), 2);
    expectSameResult(php, ts);
    await compareAll();
    expect(tsMails).toEqual(phpMails);
  });

  it("organizzazione: solo contatti primari, team come account manager", async () => {
    await execBoth(SEQUENTIAL, "UPDATE {p}organization SET status = status | 2 | 4, manager = 't1' WHERE id = 3", "UPDATE {p}user SET status = 1 WHERE id = 13");
    const vars = { topicId: 1, subject: "Org primari", message: "<p>Testo</p>" };
    expectSameResult(await phpWeb(3, vars), await tsWeb(3, vars));
    await compareAll();
  });

  it("avvisi ai membri e al responsabile del reparto", async () => {
    await execBoth(SEQUENTIAL, cfgSet("ticket_alert_dept_members", "1"), "UPDATE {p}department SET manager_id = 3 WHERE id = 1");
    const vars = { topicId: 1, subject: "Avvisi reparto", message: "<p>Testo</p>" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(async () => (php = await phpWeb(9, vars)), 4);
    const tsMails = await mailsOf(async () => (ts = await tsWeb(9, vars)), 4);
    expectSameResult(php, ts);
    await compareAll();
    expect(phpMails.length).toBeGreaterThan(2);
    expect(tsMails).toEqual(phpMails);
  });

  it("reparto senza auto-risposta e topic disattivato (→ nessun topic)", async () => {
    await execBoth(SEQUENTIAL, cfgSet("ticket_autoresponder", "1"), "UPDATE {p}department SET ticket_auto_response = 0 WHERE id = 3", "UPDATE {p}help_topic SET flags = flags & ~2 WHERE topic_id = 2");
    for (const vars of [
      { topicId: 10, subject: "Manutenzione", message: "<p>Testo</p>" },
      { topicId: 2, subject: "Topic spento", message: "<p>Testo</p>" },
    ]) {
      let php!: PhpResult;
      let ts!: CreateResult;
      const phpMails = await mailsOf(async () => (php = await phpWeb(10, vars)), 1);
      const tsMails = await mailsOf(async () => (ts = await tsWeb(10, vars)), 1);
      expectSameResult(php, ts);
      expect(tsMails).toEqual(phpMails);
    }
    await compareAll();
  });
});

describe("filtri: risposta predefinita ed email", () => {
  it("risposta predefinita automatica (con allegato) e auto-risposta ticket.autoreply", async () => {
    // risposta predefinita con variabili e a capo (compattati da htmLawed) e un allegato
    await execBoth(
      SEQUENTIAL,
      "INSERT INTO {p}canned_response (canned_id, dept_id, isenabled, title, response, lang, notes, created, updated) VALUES (3, 0, 1, 'Presa in carico', 'Ciao %{ticket.name.first},\n<br>\n<br>\nil ticket #%{ticket.number} (%{ticket.subject})   è in carico a %{ticket.dept.name}.', 'en_US', '', NOW(), NOW())",
      "INSERT INTO {p}attachment (object_id, type, file_id, name, inline, lang) VALUES (3, 'C', 2, 'guida.pdf', 0, NULL)",
      ...filterSql(10, { what: "email", how: "contains", val: "ospedale" }, [["canned", { canned_id: 3 }]]),
    );
    const vars = { topicId: 1, subject: "Canned", message: "<p>Testo</p>" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(async () => (php = await phpWeb(11, vars)), 2);
    const tsMails = await mailsOf(async () => (ts = await tsWeb(11, vars)), 2);
    expectSameResult(php, ts);
    await compareAll();
    expect(tsMails).toEqual(phpMails);
  });

  it("risposta predefinita con allegato da agente (nessuna auto-risposta)", async () => {
    await execBoth(SEQUENTIAL, ...filterSql(10, { what: "field.20", how: "starts", val: "Canned" }, [["canned", { canned_id: 1 }]]));
    const vars = { uid: 12, source: "Phone", topicId: 1, subject: "Canned da agente", message: "<p>Testo</p>", "reply-to": "none" };
    expectSameResult(await phpOpen(2, vars), await tsOpen(2, vars));
    await compareAll();
  });

  it("azione email del filtro dopo la creazione", async () => {
    await execBoth(
      SEQUENTIAL,
      ...filterSql(10, { what: "email", how: "equal", val: "l.ferrari@ospedale.example" }, [
        ["email", { recipients: "%{user}, Ufficio <ufficio@clinica.example>", subject: "Nuovo ticket #%{ticket.number}", message: "<p>Ciao %{recipient.personal}, ticket %{ticket.subject}</p>", from: 1 }],
      ]),
    );
    const vars = { topicId: 1, subject: "Con email", message: "<p>Testo</p>" };
    let php!: PhpResult;
    let ts!: CreateResult;
    const phpMails = await mailsOf(async () => (php = await phpWeb(3, vars)), 3);
    const tsMails = await mailsOf(async () => (ts = await tsWeb(3, vars)), 3);
    expectSameResult(php, ts);
    await compareAll();
    expect(phpMails.length).toBe(3);
    // nome del destinatario: il PHP lo codifica con le virgolette ("Nome"), Mailpit lo mostra con spazi
    const unquote = (m: (typeof phpMails)[number]) => ({ ...m, to: m.to.map((t) => t.replace(/^\s*"?\s*([^"<]*?)\s*"?\s*</, "$1 <")) });
    expect(tsMails.map(unquote)).toEqual(phpMails.map(unquote));
  });
});

describe("form Next → $vars (formDataToVars) e token di upload", () => {
  it("POST del form agenti con campi f.<id>, topic con form personalizzato e allegato firmato", async () => {
    await execBoth(SEQUENTIAL, ...CUSTOM_FORMS);
    const f1 = await uploadBoth("verbale.pdf", "application/pdf", Buffer.from("%PDF-1.4 verbale"));
    const cfg = await loadConfigNamespace("core");
    const fd = new FormData();
    for (const [k, v] of [
      ["uid", "4"], ["source", "Email"], ["topicId", "2"], ["reply-to", "user"], ["f.20", "Da form Next"], ["f.21", "<p>Corpo dal <b>form</b></p>"],
      ["f.22", "3"], ["f.102", "b"], ["f.110", "n"], ["f.110", "s"], ["f.103:present", "1"], ["f.105", "06 1234567"],
      ["files", signUploadToken(f1, "verbale firmato.pdf", "S2")], ["files", signUploadToken(f1, "falso.pdf", "S3")],
    ]) fd.append(k, v);
    const [tdef, topicForms] = await Promise.all([loadFormDef(db(), cfg, { type: "T" }, "staff"), loadTopicForms(db(), cfg, 2, "staff")]);
    const vars: Record<string, unknown> = { ...formDataToVars(fd, [tdef, ...topicForms.filter((f) => f.type !== "T")]) };
    for (const k of ["uid", "source", "topicId", "reply-to"]) vars[k] = String(fd.get(k));
    // il token firmato per un altro agente è scartato
    vars.files = verifyUploadTokens(fd.getAll("files").map(String), "S2");
    expect(vars.files).toEqual([{ id: f1, name: "verbale firmato.pdf" }]);
    expect(vars).toMatchObject({ subject: "Da form Next", message: "<p>Corpo dal <b>form</b></p>", priority: "3", urgenza: "b", area: ["n", "s"], garanzia: "", tel: "06 1234567" });
    const phpVars = { ...vars, "attach:21": [`${f1},verbale firmato.pdf`] };
    delete (phpVars as Record<string, unknown>).files;
    expectSameResult(await phpOpen(2, phpVars, { uploaded: { [f1]: "verbale.pdf" } }), await tsOpen(2, vars));
    await compareAll(["file.key"]);
  });
});

describe("allegati nel composer (risposta e nota)", () => {
  it("nota interna e risposta con allegati: attachment, email con allegato", async () => {
    const f1 = await uploadBoth("schema.pdf", "application/pdf", Buffer.from("%PDF-1.4 schema impianto"));
    const files = [{ id: f1, name: "schema impianto.pdf" }];
    const note = { agent: 2, ticket: 3, kind: "note", body: "<p>Vedi schema.</p>", title: "Schema", files };
    await runPhp({ op: "create.post.files", args: note });
    const agent = (await loadAgent(2, db()))!;
    await runWrite({ agent, ip: IP }, (ctx) => postNote(ctx, { ticketId: 3, note: note.body, title: note.title, files }));
    const reply = { agent: 2, ticket: 3, kind: "reply", body: "<p>In allegato lo schema.</p>", files };
    const phpMails = await mailsOf(() => runPhp({ op: "create.post.files", args: reply }), 1);
    const tsMails = await mailsOf(() => runWrite({ agent, ip: IP }, (ctx) => postReply(ctx, { ticketId: 3, response: reply.body, files })), 1);
    await compareAll(["file.key"]);
    expect(tsMails).toEqual(phpMails);
  });
});
