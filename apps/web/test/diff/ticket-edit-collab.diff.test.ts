import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb } from "@/server/db";
import { addCollaborator, updateCollaborators } from "@/server/domain/ticket/collaborators";
import { markTicketOverdue, setTicketEmailBan } from "@/server/domain/ticket/overdue";

import { execBoth, prepareSnapshot, resetWorkingDatabases } from "./lib/harness";
import { both } from "./lib/ticketedit";

/**
 * Collaboratori (aggiunta, rimozione, attivazione), "segna come scaduto" e ban list del menu "Altro"
 * (area "ticketedit").
 */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

const COLLABS =
  "INSERT INTO {p}thread_collaborator (id, flags, thread_id, user_id, role, created, updated) VALUES " +
  "(1, 3, 3, 5, 'M', '2026-01-01 00:00:00', '2026-01-01 00:00:00'), (2, 3, 3, 6, 'M', '2026-01-01 00:00:00', '2026-01-01 00:00:00'), " +
  "(3, 2, 3, 7, 'M', '2026-01-01 00:00:00', '2026-01-01 00:00:00'), (4, 3, 4, 7, 'M', '2026-01-01 00:00:00', '2026-01-01 00:00:00')";

describe("collaboratori", () => {
  it("aggiunge un collaboratore (evento collab add)", async () => {
    const r = await both("ticketedit.collab.add", { agent: 2, ticket: 3, user_id: 5 }, (ctx) => addCollaborator(ctx, { ticketId: 3, userId: 5 }));
    expect(r.php.ok).toBe(true);
    expect(r.ts).toMatchObject({ ok: true });
  });

  it("aggiunta con do=addcc", async () => {
    const r = await both("ticketedit.addcc", { agent: 1, ticket: 5, user_id: 9 }, (ctx) => addCollaborator(ctx, { ticketId: 5, userId: 9 }));
    expect(r.php.ok).toBe(true);
    expect(r.ts).toMatchObject({ ok: true });
  });

  it("il proprietario non può essere collaboratore", async () => {
    const r = await both("ticketedit.collab.add", { agent: 2, ticket: 3, user_id: 10 }, (ctx) => addCollaborator(ctx, { ticketId: 3, userId: 10 }));
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "owner" });
  });

  it("collaboratore già presente", async () => {
    await execBoth(COLLABS);
    const r = await both("ticketedit.collab.add", { agent: 2, ticket: 3, user_id: 6 }, (ctx) => addCollaborator(ctx, { ticketId: 3, userId: 6 }));
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "already_collaborator" });
  });

  it("rimuove, attiva e disattiva collaboratori", async () => {
    await execBoth(COLLABS);
    const r = await both("ticketedit.collab.update", { agent: 2, ticket: 3, del: [2], cid: [3] }, (ctx) =>
      updateCollaborators(ctx, { ticketId: 3, del: [2], cid: [3] }),
    );
    expect(r.ts).toEqual({ ok: true });
  });

  it("disattiva tutti (nessun attivo selezionato)", async () => {
    await execBoth(COLLABS);
    const r = await both("ticketedit.collab.update", { agent: 2, ticket: 3 }, (ctx) => updateCollaborators(ctx, { ticketId: 3 }));
    expect(r.ts).toEqual({ ok: true });
  });
});

describe("segna come scaduto", () => {
  it("il manager del reparto segna il ticket: evento, avviso all'assegnatario, nota di sistema", async () => {
    await execBoth("UPDATE {p}department SET manager_id = 2 WHERE id = 1");
    const r = await both("ticketedit.overdue", { agent: 2, ticket: 3 }, (ctx) => markTicketOverdue(ctx, { ticketId: 3 }), 1);
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });

  it("ticket non assegnato: avvisi ai membri del reparto e al manager", async () => {
    await execBoth(
      "UPDATE {p}department SET manager_id = 3 WHERE id = 1",
      "UPDATE {p}config SET value = '1' WHERE namespace = 'core' AND `key` = 'overdue_alert_dept_members'",
    );
    const r = await both("ticketedit.overdue", { agent: 3, ticket: 1 }, (ctx) => markTicketOverdue(ctx, { ticketId: 1 }), 4);
    expect(r.ts).toEqual({ ok: true });
  });

  it("già scaduto: solo la nota di sistema", async () => {
    await execBoth("UPDATE {p}department SET manager_id = 2 WHERE id = 1", "UPDATE {p}ticket SET isoverdue = 1 WHERE ticket_id = 3");
    const r = await both("ticketedit.overdue", { agent: 2, ticket: 3 }, (ctx) => markTicketOverdue(ctx, { ticketId: 3 }));
    expect(r.ts).toEqual({ ok: true });
  });

  it("negato a chi non è manager del reparto", async () => {
    const r = await both("ticketedit.overdue", { agent: 2, ticket: 3 }, (ctx) => markTicketOverdue(ctx, { ticketId: 3 }));
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "denied" });
  });
});

describe("ban list", () => {
  it("aggiunge l'email del proprietario alla ban list", async () => {
    const r = await both("ticketedit.ban", { agent: 1, ticket: 3, ban: true }, (ctx) => setTicketEmailBan(ctx, { ticketId: 3, ban: true }));
    expect(r.php.ok).toBe(true);
    expect(r.ts).toMatchObject({ ok: true });
  });

  it("rimuove l'email dalla ban list", async () => {
    await execBoth(
      "INSERT INTO {p}filter_rule (filter_id, what, how, val, isactive, notes, created, updated) SELECT 1, 'email', 'equal', address, 1, '', NOW(), NOW() FROM {p}user_email WHERE user_id = 10",
    );
    const r = await both("ticketedit.ban", { agent: 1, ticket: 3, ban: false }, (ctx) => setTicketEmailBan(ctx, { ticketId: 3, ban: false }));
    expect(r.php.ok).toBe(true);
    expect(r.ts).toMatchObject({ ok: true });
  });

  it("negato senza permesso emails.banlist", async () => {
    const r = await both("ticketedit.ban", { agent: 2, ticket: 3, ban: true }, (ctx) => setTicketEmailBan(ctx, { ticketId: 3, ban: true }));
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "denied" });
  });
});
