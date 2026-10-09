import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db } from "@/server/db";
import { postNote, postReply } from "@/server/domain/ticket/post";
import { loadAgent } from "@/server/domain/staff/staff";
import { runWrite } from "@/server/domain/write";

import { compareWorkingDatabases, execBoth, prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";
import { mailsOf } from "./lib/mailpit";

const IP = "127.0.0.1";

beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

async function asAgent<T>(staffId: number, fn: Parameters<typeof runWrite<T>>[1]): Promise<T> {
  const agent = await loadAgent(staffId, db());
  if (!agent) throw new Error("agente mancante");
  return runWrite({ agent, ip: IP }, fn);
}

describe("nota interna e risposta: PHP vs TypeScript", () => {
  it("nota con titolo su ticket aperto", async () => {
    const args = { agent: 2, ticket: 3, note: "<p>Verificato in reparto, <strong>badge</strong> sostituito.</p>", title: "Sopralluogo & verifica" };
    const php = await runPhp({ op: "ticket.note", args });
    const ts = await asAgent(2, (ctx) => postNote(ctx, { ticketId: 3, note: args.note, title: args.title }));
    expect(php.ok).toBe(true);
    expect(ts).toEqual({ entryId: php.id });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("risposta su ticket già risposto: solo entry, indice e lastresponse; email identica", async () => {
    const args = { agent: 2, ticket: 3, response: "<p>Buongiorno,</p><p>abbiamo sostituito il badge.</p><p></p>" };
    const phpMails = await mailsOf(() => runPhp({ op: "ticket.reply", args }), 1);
    const tsMails = await mailsOf(() => asAgent(2, (ctx) => postReply(ctx, { ticketId: 3, response: args.response })), 1);
    expect(await compareWorkingDatabases()).toEqual([]);
    expect(tsMails).toEqual(phpMails);
    expect(tsMails[0].mid.loopback).toBe(true);
  });

  it("risposta su ticket non assegnato: auto-claim e isanswered", async () => {
    const args = { agent: 2, ticket: 1, response: "<p>Presa in carico.</p>" };
    const phpMails = await mailsOf(() => runPhp({ op: "ticket.reply", args }), 1);
    const tsMails = await mailsOf(() => asAgent(2, (ctx) => postReply(ctx, { ticketId: 1, response: args.response })), 1);
    expect(await compareWorkingDatabases()).toEqual([]);
    expect(tsMails).toEqual(phpMails);
  });

  it("risposta con chiusura del ticket: stato, evento closed, referral", async () => {
    const args = { agent: 2, ticket: 9, response: "<p>Risolto, chiudiamo.</p>", statusId: 3 };
    const phpMails = await mailsOf(() => runPhp({ op: "ticket.reply", args }), 1);
    const tsMails = await mailsOf(() => asAgent(2, (ctx) => postReply(ctx, { ticketId: 9, response: args.response, statusId: 3 })), 1);
    expect(await compareWorkingDatabases()).toEqual([]);
    expect(tsMails).toEqual(phpMails);
  });

  it("nota con chiusura (note_status_id)", async () => {
    const args = { agent: 2, ticket: 18, note: "<p>Chiuso dopo verifica telefonica.</p>", title: "Chiusura", state: 2 };
    await runPhp({ op: "ticket.note", args });
    await asAgent(2, (ctx) => postNote(ctx, { ticketId: 18, note: args.note, title: args.title, statusId: 2 }));
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("risposta a tutti con un collaboratore attivo: destinatari, flag REPLY_ALL, Cc", async () => {
    await execBoth(
      "INSERT INTO {p}thread_collaborator (flags, thread_id, user_id, role, created, updated) SELECT 1, id, 2, 'M', NOW(), NOW() FROM {p}thread WHERE object_type='T' AND object_id=40",
    );
    const args = { agent: 2, ticket: 40, response: "<p>Aggiorniamo anche il collega in copia.</p>" };
    const phpMails = await mailsOf(() => runPhp({ op: "ticket.reply", args }), 1);
    const tsMails = await mailsOf(() => asAgent(2, (ctx) => postReply(ctx, { ticketId: 40, response: args.response })), 1);
    expect(await compareWorkingDatabases()).toEqual([]);
    expect(tsMails).toEqual(phpMails);
  });

  it("risposta a tutti con più collaboratori: destinatari ordinati per nome come il PHP", async () => {
    // collaboratori inseriti in ordine di id opposto al nome (Marco Gallo, Luca Ferrari, Elena Marino)
    for (const uid of [9, 3, 6]) {
      await execBoth(
        `INSERT INTO {p}thread_collaborator (flags, thread_id, user_id, role, created, updated) SELECT 1, id, ${uid}, 'M', NOW(), NOW() FROM {p}thread WHERE object_type='T' AND object_id=40`,
      );
    }
    const args = { agent: 2, ticket: 40, response: "<p>Aggiorniamo tutti i colleghi in copia.</p>" };
    const phpMails = await mailsOf(() => runPhp({ op: "ticket.reply", args }), 1);
    const tsMails = await mailsOf(() => asAgent(2, (ctx) => postReply(ctx, { ticketId: 40, response: args.response })), 1);
    expect(await compareWorkingDatabases()).toEqual([]);
    expect(tsMails).toEqual(phpMails);
  });

  it("avvisi di nuova attività agli agenti (note.alert)", async () => {
    await execBoth(
      "UPDATE {p}config SET value='1' WHERE namespace='core' AND `key` IN ('note_alert_active','note_alert_assigned','note_alert_laststaff','note_alert_dept_manager')",
      "UPDATE {p}department SET manager_id=3 WHERE id=3",
    );
    const args = { agent: 2, ticket: 4, note: "<p>Serve un intervento della manutenzione.</p>", title: "Escalation" };
    const phpMails = await mailsOf(() => runPhp({ op: "ticket.note", args }), 1);
    const tsMails = await mailsOf(() => asAgent(2, (ctx) => postNote(ctx, { ticketId: 4, note: args.note, title: args.title })), 1);
    expect(await compareWorkingDatabases()).toEqual([]);
    expect(phpMails.length).toBeGreaterThan(0);
    expect(tsMails).toEqual(phpMails);
  });
});
