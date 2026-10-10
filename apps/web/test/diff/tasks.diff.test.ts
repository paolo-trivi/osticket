import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Dept } from "@/lib/osticket/flags";
import { closeDb, db } from "@/server/db";
import { loadAgent } from "@/server/domain/staff/staff";
import { loadTaskRow } from "@/server/domain/task/model";
import {
  assignTask,
  claimTask,
  createTask,
  deleteTask,
  massTaskAction,
  postTaskNote,
  postTaskReply,
  setTaskStatus,
  transferTask,
  updateTaskDueDate,
  updateTaskFields,
} from "@/server/domain/task/write";
import type { WriteContext } from "@/server/domain/ticket/context";
import { runWriteOrThrow } from "@/server/domain/write";

import { compareWorkingDatabases, execBoth, prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";
import { mailsOf } from "./lib/mailpit";

const IP = "127.0.0.1";

beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

async function asAgent<T>(staffId: number, fn: (ctx: WriteContext) => Promise<T>): Promise<T> {
  const agent = await loadAgent(staffId, db());
  if (!agent) throw new Error("agente mancante");
  return runWriteOrThrow({ agent, ip: IP }, fn);
}

async function withTask<T>(staffId: number, taskId: number, fn: (ctx: WriteContext, task: NonNullable<Awaited<ReturnType<typeof loadTaskRow>>>) => Promise<T>): Promise<T> {
  return asAgent(staffId, async (ctx) => {
    const task = await loadTaskRow(ctx.tx, taskId, true);
    if (!task) throw new Error("task mancante");
    return fn(ctx, task);
  });
}

/** Avvisi dei task attivi (righe config assenti nel DB di sviluppo: default disattivati). */
async function enableTaskAlerts() {
  const keys = [
    "task_alert_active", "task_alert_admin", "task_alert_dept_manager", "task_alert_dept_members",
    "task_activity_alert_active", "task_activity_alert_laststaff", "task_activity_alert_assigned", "task_activity_alert_dept_manager",
    "task_transfer_alert_active", "task_transfer_alert_assigned", "task_transfer_alert_dept_manager", "task_transfer_alert_dept_members",
    "task_assignment_alert_active", "task_assignment_alert_staff", "task_assignment_alert_team_lead", "task_assignment_alert_team_members",
  ];
  await execBoth(
    ...keys.map((k) => `INSERT INTO {p}config (namespace, \`key\`, value, updated) VALUES ('core', '${k}', '1', NOW())`),
    "UPDATE {p}department SET manager_id = 3 WHERE id = 1",
    "UPDATE {p}team_member SET flags = 1",
  );
}

describe("task: PHP vs TypeScript", () => {
  it("creazione da ticket con assegnazione ad agente", async () => {
    const args = { agent: 2, ticket: 3, title: "Prova task", description: "<p>Descrizione del task</p>", deptId: 1, assignee: "s3", duedate: "" };
    const php = await runPhp<{ ok: boolean; id: number; number: string }>({ op: "task.create", args });
    const ts = await asAgent(2, (ctx) =>
      createTask(ctx, { ticketId: 3, title: args.title, description: args.description, deptId: 1, assignee: { type: "staff", id: 3 } }),
    );
    expect(php.ok).toBe(true);
    expect(ts).toEqual({ ok: true, id: php.id, number: php.number });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("campi aggiuntivi del form del task: data nel fuso dell'agente, testo numerico", async () => {
    await execBoth(
      `INSERT INTO {p}form_field (id, form_id, flags, type, label, name, configuration, sort, hint, created, updated) VALUES
        (70, 5, 13057, 'datetime', 'Intervento', 'intervento', '{"time":true}', 3, '', NOW(), NOW()),
        (71, 5, 13057, 'text', 'Stanza', 'stanza', '{"validator":"number"}', 4, '', NOW(), NOW())`,
      "ALTER TABLE {p}task__cdata ADD COLUMN intervento mediumtext",
    );
    const fields = { intervento: "2026-11-03 14:30", stanza: "12" };
    const args = { agent: 2, title: "Con campi", description: "<p>desc</p>", deptId: 1, duedate: "", fields };
    const php = await runPhp<{ ok: boolean; id: number; number: string }>({ op: "task.create", args });
    const ts = await asAgent(2, (ctx) => createTask(ctx, { title: args.title, description: args.description, deptId: 1, fields }));
    expect(php.ok).toBe(true);
    expect(ts).toEqual({ ok: true, id: php.id, number: php.number });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("campo aggiuntivo non valido: nessuna riga scritta, stesso errore", async () => {
    await execBoth(
      `INSERT INTO {p}form_field (id, form_id, flags, type, label, name, configuration, sort, hint, created, updated) VALUES
        (71, 5, 13057, 'text', 'Stanza', 'stanza', '{"validator":"number"}', 4, '', NOW(), NOW())`,
    );
    const fields = { stanza: "dodici" };
    const args = {
      agent: 2,
      title: "Titolo valido",
      description: "<p>desc</p>",
      deptId: 1,
      duedate: "",
      fields,
    };
    const php = await runPhp<{
      ok: boolean;
      errors: [unknown, Record<string, string[]>];
    }>({ op: "task.create", args });
    const ts = await asAgent(2, (ctx) =>
      createTask(ctx, {
        title: args.title,
        description: args.description,
        deptId: 1,
        fields,
      }),
    );
    expect(php.ok).toBe(false);
    expect(Object.keys(php.errors[1])).toEqual(["71"]);
    expect(ts).toEqual({ ok: false, error: "invalid", fields: { stanza: "number" } });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("campi aggiuntivi riletti dal getClean() del form: scelta multipla e lista", async () => {
    await execBoth(
      `INSERT INTO {p}form_field (id, form_id, flags, type, label, name, configuration, sort, hint, created, updated) VALUES
        (72, 5, 13057, 'choices', 'Reparti', 'reparti', '{"choices":"a:Alfa\\nb:Beta\\nc:Gamma","multiselect":true}', 5, '', NOW(), NOW()),
        (73, 5, 13057, 'choices', 'Turno', 'turno', '{"choices":"m:Mattina\\np:Pomeriggio"}', 6, '', NOW(), NOW())`,
      "ALTER TABLE {p}task__cdata ADD COLUMN reparti mediumtext, ADD COLUMN turno mediumtext",
    );
    const fields = { reparti: ["a", "c"], turno: "p" };
    const args = { agent: 2, title: "Scelte", description: "<p>desc</p>", deptId: 1, duedate: "", fields };
    const php = await runPhp<{ ok: boolean; id: number; number: string }>({ op: "task.create", args });
    const ts = await asAgent(2, (ctx) => createTask(ctx, { title: args.title, description: args.description, deptId: 1, fields }));
    expect(php.ok).toBe(true);
    expect(ts).toEqual({ ok: true, id: php.id, number: php.number });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("creazione autonoma con team e scadenza", async () => {
    const args = { agent: 2, title: "Standalone", description: "<p>desc</p>", deptId: 3, assignee: "t1", duedate: "2027-02-01T08:15:00Z" };
    await runPhp({ op: "task.create", args });
    const ts = await asAgent(2, (ctx) =>
      createTask(ctx, { title: args.title, description: args.description, deptId: 3, assignee: { type: "team", id: 1 }, duedate: args.duedate }),
    );
    expect(ts.ok).toBe(true);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("nota interna e risposta", async () => {
    await runPhp({ op: "task.note", args: { agent: 2, task: 1, note: "<p>Nota sul task</p>", title: "Titolo" } });
    await runPhp({ op: "task.reply", args: { agent: 2, task: 1, response: "<p>Aggiornamento</p>" } });
    await withTask(2, 1, (ctx, t) => postTaskNote(ctx, t, { note: "<p>Nota sul task</p>", title: "Titolo" }));
    await withTask(2, 1, (ctx, t) => postTaskReply(ctx, t, { response: "<p>Aggiornamento</p>" }));
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("assegnazione a team con commento, claim, trasferimento", async () => {
    await runPhp({ op: "task.assign", args: { agent: 2, task: 1, assignee: "t1", comments: "<p>Al team</p>" } });
    await runPhp({ op: "task.claim", args: { agent: 2, task: 2, comments: "<p>prendo io</p>" } });
    await runPhp({ op: "task.transfer", args: { agent: 2, task: 3, dept: 3, comments: "<p>sposto</p>" } });
    await withTask(2, 1, (ctx, t) => assignTask(ctx, t, { type: "team", id: 1 }, "<p>Al team</p>"));
    await withTask(2, 2, (ctx, t) => claimTask(ctx, t, "<p>prendo io</p>"));
    await withTask(2, 3, (ctx, t) => transferTask(ctx, t, 3, "<p>sposto</p>"));
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("assegnazione ad altro agente (evento con AgentsName)", async () => {
    await runPhp({ op: "task.assign", args: { agent: 2, task: 5, assignee: "s4", comments: "" } });
    await runPhp({ op: "task.assign", args: { agent: 2, task: 5, assignee: "s3", comments: "" } });
    expect(await withTask(2, 5, (ctx, t) => assignTask(ctx, t, { type: "staff", id: 4 }, ""))).toEqual({ ok: false, error: "unknown_assignee" });
    await withTask(2, 5, (ctx, t) => assignTask(ctx, t, { type: "staff", id: 3 }, ""));
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("chiusura con commento (nota sul ticket) e riapertura", async () => {
    await runPhp({ op: "task.status", args: { agent: 2, task: 1, status: "closed", comments: "<p>fatto</p>" } });
    await runPhp({ op: "task.status", args: { agent: 2, task: 4, status: "open", comments: "" } });
    await withTask(2, 1, (ctx, t) => setTaskStatus(ctx, t, "closed", "<p>fatto</p>"));
    await withTask(2, 4, (ctx, t) => setTaskStatus(ctx, t, "open", ""));
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("riapertura di task il cui ticket è chiuso (riapre il ticket)", async () => {
    await execBoth("UPDATE {p}task SET flags = 0, closed = NOW() WHERE id = 3", // topic_id = 0: TopicFlag in ticket/status.ts ha i bit di ACTIVE/ARCHIVED invertiti (segnalato al coordinatore)
      "UPDATE {p}ticket SET status_id = 3, closed = NOW(), topic_id = 0 WHERE ticket_id = 26");
    await runPhp({ op: "task.status", args: { agent: 2, task: 3, status: "open", comments: "<p>di nuovo</p>" } });
    await withTask(2, 3, (ctx, t) => setTaskStatus(ctx, t, "open", "<p>di nuovo</p>"));
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("riapertura del ticket dal task: stato di riapertura non consentito o non aperto (TicketStatus::getReopenStatus)", async () => {
    // Stato "Closed" con reopenstatus ma allowreopen falso, "Resolved" con reopenstatus verso uno stato chiuso:
    // in entrambi i casi il PHP ignora la configurazione e usa lo stato predefinito.
    await execBoth(
      "INSERT INTO {p}ticket_status (id, name, state, mode, flags, sort, properties, created, updated) VALUES (6, 'Riaperto', 'open', 1, 0, 6, '{\"description\":\"\"}', NOW(), NOW())",
      'UPDATE {p}ticket_status SET properties = \'{"allowreopen":false,"reopenstatus":6}\' WHERE id = 3',
      'UPDATE {p}ticket_status SET properties = \'{"allowreopen":true,"reopenstatus":3}\' WHERE id = 2',
      "UPDATE {p}task SET flags = 0, closed = NOW() WHERE id IN (2, 3)",
      "UPDATE {p}ticket SET status_id = 3, closed = NOW(), topic_id = 0 WHERE ticket_id = 26",
      "UPDATE {p}ticket SET status_id = 2, closed = NOW(), topic_id = 0 WHERE ticket_id = 24",
    );
    await runPhp({ op: "task.status", args: { agent: 2, task: 3, status: "open", comments: "" } });
    await runPhp({ op: "task.status", args: { agent: 2, task: 2, status: "open", comments: "" } });
    await withTask(2, 3, (ctx, t) => setTaskStatus(ctx, t, "open", ""));
    await withTask(2, 2, (ctx, t) => setTaskStatus(ctx, t, "open", ""));
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("riapertura del ticket dal task con stato di riapertura configurato", async () => {
    await execBoth(
      "INSERT INTO {p}ticket_status (id, name, state, mode, flags, sort, properties, created, updated) VALUES (6, 'Riaperto', 'open', 1, 0, 6, '{\"description\":\"\"}', NOW(), NOW())",
      'UPDATE {p}ticket_status SET properties = \'{"allowreopen":true,"reopenstatus":6}\' WHERE id = 3',
      "UPDATE {p}task SET flags = 0, closed = NOW() WHERE id = 3",
      "UPDATE {p}ticket SET status_id = 3, closed = NOW(), topic_id = 0 WHERE ticket_id = 26",
    );
    await runPhp({ op: "task.status", args: { agent: 2, task: 3, status: "open", comments: "" } });
    await withTask(2, 3, (ctx, t) => setTaskStatus(ctx, t, "open", ""));
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("modifica dei campi, scadenza ed eliminazione", async () => {
    await runPhp({ op: "task.edit", args: { agent: 2, task: 1, fields: { title: "Nuovo titolo" }, note: "<p>cambiato</p>" } });
    await runPhp({ op: "task.duedate", args: { agent: 2, task: 2, duedate: "2027-01-15T10:30:00Z", comments: "<p>scadenza</p>" } });
    await runPhp({ op: "task.delete", args: { agent: 1, task: 5, comments: "motivo" } });
    await withTask(2, 1, (ctx, t) => updateTaskFields(ctx, t, { title: "Nuovo titolo" }, "<p>cambiato</p>"));
    await withTask(2, 2, (ctx, t) => updateTaskDueDate(ctx, t, "2027-01-15T10:30:00Z", "<p>scadenza</p>"));
    await withTask(1, 5, (ctx, t) => deleteTask(ctx, t, "motivo"));
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("modifica con un campo aggiuntivo non valido: nessuna scrittura, errori per campo", async () => {
    await execBoth(
      `INSERT INTO {p}form_field (id, form_id, flags, type, label, name, configuration, sort, hint, created, updated) VALUES
        (71, 5, 13057, 'text', 'Stanza', 'stanza', '{"validator":"number"}', 4, '', NOW(), NOW())`,
    );
    const fields = { title: "Nuovo titolo", stanza: "dodici" };
    const php = await runPhp<{ ok: boolean; errors: Record<string, unknown> }>({ op: "task.edit", args: { agent: 2, task: 1, fields, note: "<p>x</p>" } });
    const ts = await withTask(2, 1, (ctx, t) => updateTaskFields(ctx, t, fields, "<p>x</p>"));
    expect(php.ok).toBe(false);
    // un solo errore (array_merge rinumera la chiave 71 del campo)
    expect(Object.keys(php.errors)).toHaveLength(1);
    expect(ts).toEqual({ ok: false, error: "invalid", fields: { stanza: "number" } });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("azioni di massa: claim, chiusura, eliminazione", async () => {
    await runPhp({ op: "task.mass", args: { agent: 1, action: "claim", tids: [1, 2] } });
    await runPhp({ op: "task.mass", args: { agent: 1, action: "close", tids: [1, 3], comments: "" } });
    await runPhp({ op: "task.mass", args: { agent: 1, action: "delete", tids: [5] } });
    await asAgent(1, (ctx) => massTaskAction(ctx, [1, 2], { action: "claim" }));
    await asAgent(1, (ctx) => massTaskAction(ctx, [1, 3], { action: "close", comments: "" }));
    await asAgent(1, (ctx) => massTaskAction(ctx, [5], { action: "delete" }));
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  // Differenza voluta (doc 17 §3): il reparto di destinazione si valida come TransferForm del PHP
  it("trasferimento di massa verso un reparto non selezionabile: rifiutato, nessuna riga scritta", async () => {
    await execBoth(`UPDATE {p}department SET flags = flags & ~${Dept.ACTIVE} WHERE id = 2`);
    expect(await asAgent(1, (ctx) => massTaskAction(ctx, [1, 2], { action: "transfer", deptId: 2 }))).toBe(0);
    expect(await asAgent(1, (ctx) => massTaskAction(ctx, [1, 2], { action: "transfer", deptId: 9999 }))).toBe(0);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("avvisi: nuovo task, assegnazione, attività, trasferimento (email identiche)", async () => {
    await enableTaskAlerts();
    const create = { agent: 2, title: "Con avvisi", description: "<p>Testo</p>", deptId: 1, assignee: "s3", duedate: "" };
    const phpMails = await mailsOf(async () => {
      await runPhp({ op: "task.create", args: create });
      await runPhp({ op: "task.note", args: { agent: 2, task: 1, note: "<p>Nota</p>", title: "N" } });
      await runPhp({ op: "task.transfer", args: { agent: 2, task: 2, dept: 3, comments: "<p>sposto</p>" } });
    }, 1);
    const tsMails = await mailsOf(async () => {
      await asAgent(2, (ctx) => createTask(ctx, { title: create.title, description: create.description, deptId: 1, assignee: { type: "staff", id: 3 } }));
      await withTask(2, 1, (ctx, t) => postTaskNote(ctx, t, { note: "<p>Nota</p>", title: "N" }));
      await withTask(2, 2, (ctx, t) => transferTask(ctx, t, 3, "<p>sposto</p>"));
    }, phpMails.length);
    expect(await compareWorkingDatabases()).toEqual([]);
    expect(phpMails.length).toBeGreaterThan(0);
    const key = (m: { to: string[]; subject: string }) => `${m.to.join(",")}|${m.subject}`;
    expect([...tsMails].sort((a, b) => key(a).localeCompare(key(b)))).toEqual([...phpMails].sort((a, b) => key(a).localeCompare(key(b))));
  });
});
