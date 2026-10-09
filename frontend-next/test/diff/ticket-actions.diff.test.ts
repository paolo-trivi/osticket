import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db } from "@/server/db";
import { loadAgent } from "@/server/domain/staff/staff";
import { assignTicket, claimTicket, referTicket, releaseTicket } from "@/server/domain/ticket/assign";
import type { WriteContext } from "@/server/domain/ticket/context";
import { changeTicketStatus, markTicketAnswered } from "@/server/domain/ticket/ticket-state";
import { transferTicket } from "@/server/domain/ticket/transfer";
import { runWrite } from "@/server/domain/write";

import { compareWorkingDatabases, execBoth, prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";
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
  expect(await compareWorkingDatabases()).toEqual([]);
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
