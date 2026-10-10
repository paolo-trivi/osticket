import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db } from "@/server/db";
import { loadAgent } from "@/server/domain/staff/staff";
import { assignTicket, claimTicket, releaseTicket } from "@/server/domain/ticket/assign";
import { referTicket, removeReferrals } from "@/server/domain/ticket/referral";
import type { WriteContext } from "@/server/domain/ticket/context";
import { changeTicketStatus, markTicketAnswered } from "@/server/domain/ticket/ticket-state";
import { transferTicket } from "@/server/domain/ticket/transfer";
import { runWrite } from "@/server/domain/write";

import { compareWorkingDatabases, execBoth, PHP_DB, prepareSnapshot, resetWorkingDatabases, runPhp, TS_DB, type TableDiff } from "./lib/harness";
import { mailsOf } from "./lib/mailpit";

/**
 * Azioni sul ticket da parte di un agente (area "actions"): ogni scenario esegue la stessa operazione
 * con il PHP originale (test/diff/php/ops/actions.php) e con il servizio TypeScript, poi confronta
 * tutte le tabelle e le email catturate da Mailpit.
 */
const IP = "127.0.0.1";

beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

async function asAgent<T>(staffId: number, fn: (ctx: WriteContext) => Promise<T>): Promise<T> {
  const agent = await loadAgent(staffId, db());
  if (!agent) throw new Error("agente mancante");
  return runWrite({ agent, ip: IP }, fn);
}

type Result = { ok?: boolean; error?: string | number };

/**
 * ticket.est_duedate alla riapertura è "adesso + ore SLA": PHP e TS girano in istanti diversi e
 * possono cadere a cavallo di un secondo (l'harness normalizza solo i datetime vicini a NOW).
 * Si tollera uno scarto fino a 2 s su quella sola colonna; ogni altra differenza resta.
 */
function withoutDueDateDrift(diffs: TableDiff[]): TableDiff[] {
  const toMs = (v: unknown) => (typeof v === "string" ? Date.parse(v.replace(" ", "T") + "Z") : NaN);
  return diffs.filter((d) => {
    if (d.table !== "ticket" || d.onlyInPhp.length !== d.onlyInTs.length) return true;
    const byId = new Map(d.onlyInTs.map((r) => [r.ticket_id, r]));
    return !d.onlyInPhp.every((p) => {
      const t = byId.get(p.ticket_id);
      if (!t) return false;
      const { est_duedate: pd, ...pr } = p;
      const { est_duedate: td, ...tr } = t;
      return JSON.stringify(pr) === JSON.stringify(tr) && Math.abs(toMs(pd) - toMs(td)) <= 2000;
    });
  });
}

/** PHP poi TS; confronto di DB ed email. */
async function both(op: string, args: Record<string, unknown>, ts: (ctx: WriteContext) => Promise<unknown>, mails = 0) {
  let php: Result = {};
  const phpMails = await mailsOf(async () => {
    php = await runPhp<Result>({ op, args });
  }, mails);
  let res: unknown;
  const tsMails = await mailsOf(async () => {
    res = await asAgent(Number(args.agent), ts);
  }, mails);
  expect(withoutDueDateDrift(await compareWorkingDatabases())).toEqual([]);
  expect(tsMails).toEqual(phpMails);
  expect(tsMails.length).toBe(mails);
  return { php, ts: res as Result };
}

describe("assegnazione e presa in carico", () => {
  it("assegna ad altro agente con referral al precedente, nota e avviso assigned.alert", async () => {
    const args = { agent: 2, ticket: 3, assignee: "s3", refer: true, comments: "<p>Passo a <strong>Laura</strong> per competenza.</p>" };
    const r = await both("actions.assign", args, (ctx) => assignTicket(ctx, { ticketId: 3, assignee: "s3", refer: true, comments: args.comments }), 1);
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });

  it("assegna ad agente senza commenti: evento e avviso senza nota", async () => {
    const args = { agent: 1, ticket: 11, assignee: "s2" };
    const r = await both("actions.assign", args, (ctx) => assignTicket(ctx, { ticketId: 11, assignee: "s2" }), 1);
    expect(r.ts).toEqual({ ok: true });
  });

  it("assegna a sé stesso (claim implicito): nessun avviso", async () => {
    const args = { agent: 2, ticket: 9, assignee: "s2", comments: "<p>Me ne occupo io.</p>" };
    const r = await both("actions.assign", args, (ctx) => assignTicket(ctx, { ticketId: 9, assignee: "s2", comments: args.comments }), 0);
    expect(r.ts).toEqual({ ok: true });
  });

  it("assegna a un team con avvisi ai membri del team", async () => {
    await execBoth(
      "UPDATE {p}config SET value='1' WHERE namespace='core' AND `key`='assigned_alert_team_members'",
      "UPDATE {p}team_member SET flags=1 WHERE team_id=1",
    );
    const args = { agent: 2, ticket: 1, assignee: "t1", comments: "<p>Al primo livello.</p>" };
    const r = await both("actions.assign", args, (ctx) => assignTicket(ctx, { ticketId: 1, assignee: "t1", comments: args.comments }), 2);
    expect(r.ts).toEqual({ ok: true });
  });

  it("riassegna team con referral al team precedente", async () => {
    await execBoth(
      "INSERT INTO {p}team (team_id, lead_id, flags, name, notes, created, updated) VALUES (2, 0, 1, 'Level II', '', NOW(), NOW())",
      "INSERT INTO {p}team_member (team_id, staff_id, flags) VALUES (2, 4, 0)",
    );
    const args = { agent: 1, ticket: 42, assignee: "t2", refer: true };
    const r = await both("actions.assign", args, (ctx) => assignTicket(ctx, { ticketId: 42, assignee: "t2", refer: true }), 0);
    expect(r.ts).toEqual({ ok: true });
  });

  it("assegna un ticket chiuso: riapertura (onAssign) e avviso con nota", async () => {
    const args = { agent: 1, ticket: 5, assignee: "s3", comments: "<p>Riapro e assegno.</p>" };
    const r = await both("actions.assign", args, (ctx) => assignTicket(ctx, { ticketId: 5, assignee: "s3", comments: args.comments }), 1);
    expect(r.ts).toEqual({ ok: true });
  });

  it("assegnazione rifiutata: agente già assegnato", async () => {
    const args = { agent: 2, ticket: 3, assignee: "s2" };
    const r = await both("actions.assign", args, (ctx) => assignTicket(ctx, { ticketId: 3, assignee: "s2" }), 0);
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "already_assigned_agent" });
  });

  it("assegnazione rifiutata: reparto con solo membri", async () => {
    await execBoth("UPDATE {p}department SET flags = flags | 1 WHERE id=1");
    const args = { agent: 1, ticket: 1, assignee: "s4" };
    const r = await both("actions.assign", args, (ctx) => assignTicket(ctx, { ticketId: 1, assignee: "s4" }), 0);
    expect(r.php.ok).toBe(false);
    expect(r.ts).toHaveProperty("error");
  });

  it("assegnazione negata senza permesso (ruolo View only)", async () => {
    await execBoth("UPDATE {p}staff SET assigned_only=0 WHERE staff_id=5");
    const args = { agent: 5, ticket: 1, assignee: "s2" };
    const r = await both("actions.assign", args, (ctx) => assignTicket(ctx, { ticketId: 1, assignee: "s2" }), 0);
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "denied" });
  });

  it("presa in carico (claim) con commento", async () => {
    const args = { agent: 2, ticket: 1, comments: "<p>Lo prendo io.</p>" };
    const r = await both("actions.claim", args, (ctx) => claimTicket(ctx, { ticketId: 1, comments: args.comments }), 0);
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });

  it("presa in carico di un ticket assegnato al team, con referral dell'agente", async () => {
    await execBoth("INSERT INTO {p}thread_referral (thread_id, object_id, object_type, created) SELECT id, 3, 'S', NOW() FROM {p}thread WHERE object_type='T' AND object_id=49");
    const args = { agent: 3, ticket: 49 };
    const r = await both("actions.claim", args, (ctx) => claimTicket(ctx, { ticketId: 49 }), 0);
    expect(r.ts).toEqual({ ok: true });
  });
});

describe("rilascio", () => {
  it("rilascia l'agente con nota", async () => {
    const args = { agent: 2, ticket: 3, sid: true, comments: "<p>In ferie da domani.</p>" };
    const r = await both("actions.release", args, (ctx) => releaseTicket(ctx, { ticketId: 3, staff: true, comments: args.comments }), 0);
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });

  it("rilascia agente e team", async () => {
    await execBoth("UPDATE {p}ticket SET staff_id=3 WHERE ticket_id=42");
    const args = { agent: 1, ticket: 42, sid: true, tid: true };
    const r = await both("actions.release", args, (ctx) => releaseTicket(ctx, { ticketId: 42, staff: true, team: true }), 0);
    expect(r.ts).toEqual({ ok: true });
  });

  it("rilascia solo il team", async () => {
    await execBoth("UPDATE {p}ticket SET staff_id=3 WHERE ticket_id=42");
    const args = { agent: 1, ticket: 42, tid: true };
    const r = await both("actions.release", args, (ctx) => releaseTicket(ctx, { ticketId: 42, team: true }), 0);
    expect(r.ts).toEqual({ ok: true });
  });
});

describe("trasferimento di reparto", () => {
  it("trasferisce un ticket aperto: agente azzerato (solo membri), nota, referral, avvisi a membri e manager", async () => {
    await execBoth(
      "UPDATE {p}config SET value='1' WHERE namespace='core' AND `key` IN ('transfer_alert_active','transfer_alert_dept_manager','transfer_alert_dept_members')",
      "UPDATE {p}department SET flags = flags | 1, manager_id=4 WHERE id=2",
    );
    const args = { agent: 1, ticket: 3, dept: 2, refer: true, comments: "<p>Richiesta commerciale.</p>" };
    const r = await both("actions.transfer", args, (ctx) => transferTicket(ctx, { ticketId: 3, deptId: 2, refer: true, comments: args.comments }), 2);
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });

  it("trasferisce un ticket assegnato: avviso all'assegnatario", async () => {
    await execBoth("UPDATE {p}config SET value='1' WHERE namespace='core' AND `key` IN ('transfer_alert_active','transfer_alert_assigned')");
    const args = { agent: 1, ticket: 11, dept: 3 };
    const r = await both("actions.transfer", args, (ctx) => transferTicket(ctx, { ticketId: 11, deptId: 3 }), 1);
    expect(r.ts).toEqual({ ok: true });
  });

  it("trasferisce un ticket assegnato al team: avvisi ai membri con nota", async () => {
    await execBoth(
      "UPDATE {p}config SET value='1' WHERE namespace='core' AND `key` IN ('transfer_alert_active','transfer_alert_assigned')",
      "UPDATE {p}team_member SET flags=1 WHERE team_id=1",
    );
    const args = { agent: 1, ticket: 42, dept: 3, comments: "<p>Al reparto <em>manutenzione</em>.</p>" };
    const r = await both("actions.transfer", args, (ctx) => transferTicket(ctx, { ticketId: 42, deptId: 3, comments: args.comments }), 2);
    expect(r.ts).toEqual({ ok: true });
  });

  it("trasferisce un ticket chiuso: riapertura, riassegnazione e nuova scadenza SLA", async () => {
    const args = { agent: 1, ticket: 2, dept: 3, comments: "<p>Riaperto per la manutenzione.</p>" };
    const r = await both("actions.transfer", args, (ctx) => transferTicket(ctx, { ticketId: 2, deptId: 3, comments: args.comments }), 0);
    expect(r.ts).toEqual({ ok: true });
  });

  it("trasferisce un ticket senza SLA: SLA del nuovo reparto", async () => {
    await execBoth("UPDATE {p}ticket SET sla_id=0 WHERE ticket_id=18");
    const args = { agent: 1, ticket: 18, dept: 2 };
    const r = await both("actions.transfer", args, (ctx) => transferTicket(ctx, { ticketId: 18, deptId: 2 }), 0);
    expect(r.ts).toEqual({ ok: true });
  });

  it("trasferimento rifiutato: stesso reparto", async () => {
    const args = { agent: 1, ticket: 3, dept: 1 };
    const r = await both("actions.transfer", args, (ctx) => transferTicket(ctx, { ticketId: 3, deptId: 1 }), 0);
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "already_in_dept" });
  });
});

describe("referral", () => {
  it("a un agente con nota", async () => {
    const args = { agent: 2, ticket: 3, target: "agent", id: 4, comments: "<p>Serve il parere commerciale.</p>" };
    const r = await both("actions.refer", args, (ctx) => referTicket(ctx, { ticketId: 3, target: "agent", id: 4, comments: args.comments }), 0);
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });

  it("a un team", async () => {
    const args = { agent: 2, ticket: 3, target: "team", id: 1 };
    const r = await both("actions.refer", args, (ctx) => referTicket(ctx, { ticketId: 3, target: "team", id: 1 }), 0);
    expect(r.ts).toEqual({ ok: true });
  });

  it("a un reparto", async () => {
    const args = { agent: 2, ticket: 3, target: "dept", id: 3 };
    const r = await both("actions.refer", args, (ctx) => referTicket(ctx, { ticketId: 3, target: "dept", id: 3 }), 0);
    expect(r.ts).toEqual({ ok: true });
  });

  it("rifiutato se già presente", async () => {
    const args = { agent: 2, ticket: 2, target: "dept", id: 3 };
    await execBoth("INSERT INTO {p}thread_referral (thread_id, object_id, object_type, created) SELECT id, 3, 'D', NOW() FROM {p}thread WHERE object_type='T' AND object_id=2");
    const r = await both("actions.refer", args, (ctx) => referTicket(ctx, { ticketId: 2, target: "dept", id: 3 }), 0);
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "refer_failed" });
  });
});

describe("cambio stato e risposto", () => {
  it("chiusura da menu con commento", async () => {
    const args = { agent: 2, ticket: 6, status_id: 3, comments: "<p>Chiuso su richiesta.</p>" };
    const r = await both("actions.status", args, (ctx) => changeTicketStatus(ctx, { ticketId: 6, statusId: 3, comments: args.comments }), 0);
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });

  it("risolto senza commento", async () => {
    const args = { agent: 2, ticket: 21, status_id: 2 };
    const r = await both("actions.status", args, (ctx) => changeTicketStatus(ctx, { ticketId: 21, statusId: 2 }), 0);
    expect(r.ts).toEqual({ ok: true });
  });

  it("riapertura da menu con commento: stato, riassegnazione, SLA", async () => {
    const args = { agent: 2, ticket: 2, status_id: 1, comments: "<p>Il problema si è ripresentato.</p>" };
    const r = await both("actions.status", args, (ctx) => changeTicketStatus(ctx, { ticketId: 2, statusId: 1, comments: args.comments }), 0);
    expect(r.ts).toEqual({ ok: true });
  });

  it("chiusura con i ticket figli", async () => {
    await execBoth("UPDATE {p}ticket SET ticket_pid=6, flags=flags|8 WHERE ticket_id IN (36, 46)", "UPDATE {p}ticket SET flags=flags|16 WHERE ticket_id=6");
    const args = { agent: 1, ticket: 6, status_id: 3, children: true };
    const r = await both("actions.status", args, (ctx) => changeTicketStatus(ctx, { ticketId: 6, statusId: 3, children: true }), 0);
    // il figlio #305907 non è chiudibile (stesso esito del PHP)
    expect(r.php).toMatchObject({ ok: true, failures: { 46: "305907" } });
    expect(r.ts).toEqual({ ok: true, warn: "305907" });
  });

  it("chiusura negata senza PERM_CLOSE (Limited Access)", async () => {
    const args = { agent: 4, ticket: 26, status_id: 3 };
    const r = await both("actions.status", args, (ctx) => changeTicketStatus(ctx, { ticketId: 26, statusId: 3 }), 0);
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "denied" });
  });

  it("segna come risposto con commento", async () => {
    const args = { agent: 1, ticket: 1, action: "answered", comments: "<p>Risposto al telefono.</p>" };
    const r = await both("actions.mark", args, (ctx) => markTicketAnswered(ctx, { ticketId: 1, answered: true, comments: args.comments }), 0);
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });

  it("segna come non risposto", async () => {
    const args = { agent: 1, ticket: 3, action: "unanswered" };
    const r = await both("actions.mark", args, (ctx) => markTicketAnswered(ctx, { ticketId: 3, answered: false }), 0);
    expect(r.ts).toEqual({ ok: true });
  });

  it("segna come risposto negato senza permesso (Expanded Access)", async () => {
    const args = { agent: 2, ticket: 1, action: "answered" };
    const r = await both("actions.mark", args, (ctx) => markTicketAnswered(ctx, { ticketId: 1, answered: true }), 0);
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "denied" });
  });

  it("segna come risposto rifiutato se già risposto", async () => {
    const args = { agent: 1, ticket: 3, action: "answered" };
    const r = await both("actions.mark", args, (ctx) => markTicketAnswered(ctx, { ticketId: 3, answered: true }), 0);
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "already_answered" });
  });
});

describe("avvisi, permessi da manager e casi limite", () => {
  it("assegna a un team: avviso al solo capo team (assigned_alert_team_lead)", async () => {
    await execBoth(
      "UPDATE {p}config SET value='1' WHERE namespace='core' AND `key`='assigned_alert_team_lead'",
      "UPDATE {p}team SET lead_id=3 WHERE team_id=1",
    );
    const args = { agent: 2, ticket: 1, assignee: "t1", comments: "<p>Al capo team.</p>" };
    const r = await both("actions.assign", args, (ctx) => assignTicket(ctx, { ticketId: 1, assignee: "t1", comments: args.comments }), 1);
    expect(r.ts).toEqual({ ok: true });
  });

  it("assegna a un team con flag NOALERTS: nessun avviso", async () => {
    await execBoth(
      "UPDATE {p}config SET value='1' WHERE namespace='core' AND `key` IN ('assigned_alert_team_lead','assigned_alert_team_members')",
      "UPDATE {p}team SET lead_id=3, flags=3 WHERE team_id=1",
      "UPDATE {p}team_member SET flags=1 WHERE team_id=1",
    );
    const args = { agent: 1, ticket: 1, assignee: "t1" };
    const r = await both("actions.assign", args, (ctx) => assignTicket(ctx, { ticketId: 1, assignee: "t1" }), 0);
    expect(r.ts).toEqual({ ok: true });
  });

  it("assegnazione rifiutata: agente in ferie (non tra le scelte)", async () => {
    await execBoth("UPDATE {p}staff SET onvacation=1 WHERE staff_id=3");
    const args = { agent: 1, ticket: 1, assignee: "s3" };
    const r = await both("actions.assign", args, (ctx) => assignTicket(ctx, { ticketId: 1, assignee: "s3" }), 0);
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "unknown_assignee" });
  });

  it("presa in carico rifiutata: ticket già assegnato a un agente", async () => {
    const args = { agent: 1, ticket: 3 };
    const r = await both("actions.claim", args, (ctx) => claimTicket(ctx, { ticketId: 3 }), 0);
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "denied" });
  });

  it("rilascio da manager del reparto senza PERM_RELEASE", async () => {
    await execBoth("UPDATE {p}staff SET assigned_only=0 WHERE staff_id=5", "UPDATE {p}department SET manager_id=5 WHERE id=1");
    const args = { agent: 5, ticket: 3, sid: true, comments: "<p>Rilasciato dal responsabile.</p>" };
    const r = await both("actions.release", args, (ctx) => releaseTicket(ctx, { ticketId: 3, staff: true, comments: args.comments }), 0);
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });

  it("segna come risposto da manager del reparto senza PERM_MARKANSWERED", async () => {
    await execBoth("UPDATE {p}department SET manager_id=2 WHERE id=1");
    const args = { agent: 2, ticket: 1, action: "answered" };
    const r = await both("actions.mark", args, (ctx) => markTicketAnswered(ctx, { ticketId: 1, answered: true }), 0);
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });

  it("referral a un reparto con avvisi note.alert", async () => {
    await execBoth("UPDATE {p}config SET value='1' WHERE namespace='core' AND `key` IN ('note_alert_active','note_alert_dept_manager')", "UPDATE {p}department SET manager_id=4 WHERE id=1");
    const args = { agent: 1, ticket: 3, target: "dept", id: 2, comments: "<p>Coinvolgo le vendite.</p>" };
    const r = await both("actions.refer", args, (ctx) => referTicket(ctx, { ticketId: 3, target: "dept", id: 2, comments: args.comments }), 2);
    expect(r.ts).toEqual({ ok: true });
  });

  it("referral rifiutato: agente già assegnatario", async () => {
    await execBoth("UPDATE {p}ticket SET staff_id=4 WHERE ticket_id=3");
    const args = { agent: 1, ticket: 3, target: "agent", id: 4 };
    const r = await both("actions.refer", args, (ctx) => referTicket(ctx, { ticketId: 3, target: "agent", id: 4 }), 0);
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "already_assigned_agent" });
  });

  it("rimozione di referral (gestione referral), id estranei ignorati", async () => {
    await execBoth(
      "INSERT INTO {p}thread_referral (id, thread_id, object_id, object_type, created) SELECT 901, id, 3, 'D', NOW() FROM {p}thread WHERE object_type='T' AND object_id=2",
      "INSERT INTO {p}thread_referral (id, thread_id, object_id, object_type, created) SELECT 902, id, 4, 'S', NOW() FROM {p}thread WHERE object_type='T' AND object_id=2",
      "INSERT INTO {p}thread_referral (id, thread_id, object_id, object_type, created) SELECT 903, id, 4, 'S', NOW() FROM {p}thread WHERE object_type='T' AND object_id=3",
    );
    const args = { agent: 2, ticket: 2, ids: [901, 903] };
    const r = await both("actions.referrals.remove", args, (ctx) => removeReferrals(ctx, { ticketId: 2, ids: [901, 903] }), 0);
    expect(r.php).toMatchObject({ ok: true, removed: 1 });
    expect(r.ts).toEqual({ ok: true, removed: 1 });
  });

  it("chiusura rifiutata: ticket con task aperti", async () => {
    const args = { agent: 1, ticket: 1, status_id: 3, comments: "<p>Chiudo.</p>" };
    const r = await both("actions.status", args, (ctx) => changeTicketStatus(ctx, { ticketId: 1, statusId: 3, comments: args.comments }), 0);
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "not_closeable", detail: "This ticket has 1 open tasks and cannot be closed" });
  });

  it("riapertura con il solo PERM_CREATE (Limited Access)", async () => {
    await execBoth("UPDATE {p}ticket SET dept_id=2 WHERE ticket_id=37");
    const args = { agent: 4, ticket: 37, status_id: 1, comments: "<p>Riapro.</p>" };
    const r = await both("actions.status", args, (ctx) => changeTicketStatus(ctx, { ticketId: 37, statusId: 1, comments: args.comments }), 0);
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });

  it("riapertura del padre e dei figli (FLAG_PARENT)", async () => {
    await execBoth("UPDATE {p}ticket SET ticket_pid=2, flags=flags|8 WHERE ticket_id IN (37, 41)", "UPDATE {p}ticket SET flags=flags|16 WHERE ticket_id=2");
    const args = { agent: 1, ticket: 2, status_id: 1, children: true, comments: "<p>Riapro tutto.</p>" };
    const r = await both("actions.status", args, (ctx) => changeTicketStatus(ctx, { ticketId: 2, statusId: 1, children: true, comments: args.comments }), 0);
    expect(r.php).toMatchObject({ ok: true, failures: [] });
    expect(r.ts).toEqual({ ok: true });
  });

  it("figli ignorati senza FLAG_PARENT", async () => {
    await execBoth("UPDATE {p}ticket SET ticket_pid=6 WHERE ticket_id IN (36)");
    const args = { agent: 1, ticket: 6, status_id: 2, children: true };
    const r = await both("actions.status", args, (ctx) => changeTicketStatus(ctx, { ticketId: 6, statusId: 2, children: true }), 0);
    expect(r.ts).toEqual({ ok: true });
  });

  it("stato deleted senza aggancio di eliminazione: rifiutato senza scritture", async () => {
    const r = await asAgent(1, (ctx) => changeTicketStatus(ctx, { ticketId: 3, statusId: 5 }));
    expect(r).toEqual({ error: "not_supported" });
    const denied = await asAgent(2, (ctx) => changeTicketStatus(ctx, { ticketId: 3, statusId: 5 }, { hardDelete: async () => true }));
    expect(denied).toEqual({ error: "denied" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});

/** status_id di un ticket in uno dei due DB di lavoro */
async function statusIn(dbName: string, ticketId: number): Promise<number | undefined> {
  const { rows } = await sql<{ s: number }>`SELECT status_id AS s FROM ${sql.raw(`\`${dbName}\`.ost_ticket`)} WHERE ticket_id = ${ticketId}`.execute(db());
  return rows[0]?.s;
}

describe("stati non selezionabili (differenza voluta: solo stati abilitati open/closed)", () => {
  it("stato disabilitato dal menu Cambia stato: il PHP lo applica, TailTicket lo rifiuta", async () => {
    await execBoth("UPDATE {p}ticket_status SET mode = mode & ~1 WHERE id = 2");
    const before = await statusIn(TS_DB, 21);
    const php = await runPhp<Result>({ op: "actions.status", args: { agent: 2, ticket: 21, status_id: 2 } });
    const ts = await asAgent(2, (ctx) => changeTicketStatus(ctx, { ticketId: 21, statusId: 2 }));
    expect(php.ok).toBe(true);
    expect(await statusIn(PHP_DB, 21)).toBe(2);
    expect(ts).toEqual({ error: "invalid_status" });
    expect(await statusIn(TS_DB, 21)).toBe(before);
  });
});

describe("chiusura con campo obbligatorio disabilitato (differenza voluta)", () => {
  it("campo 'obbligatorio in chiusura' ma disabilitato e vuoto: il PHP rifiuta la chiusura, TailTicket chiude", async () => {
    // priorità del form ticket: obbligatoria in chiusura (0x4) ma disabilitata (senza 0x1), valore vuoto sul ticket 21
    await execBoth(
      "UPDATE {p}form_field SET flags = (flags | 4) & ~1 WHERE id = 22",
      "UPDATE {p}form_entry_values SET value = NULL, value_id = NULL WHERE entry_id = 41 AND field_id = 22",
    );
    const php = await runPhp<Result>({ op: "actions.status", args: { agent: 2, ticket: 21, status_id: 2 } });
    const ts = await asAgent(2, (ctx) => changeTicketStatus(ctx, { ticketId: 21, statusId: 2 }));
    expect(php.ok).toBe(false);
    expect(await statusIn(PHP_DB, 21)).not.toBe(2);
    expect(ts).toEqual({ ok: true });
    expect(await statusIn(TS_DB, 21)).toBe(2);
  });
});
