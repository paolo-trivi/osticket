import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb } from "@/server/db";
import { changeTicketOwner, updateTicket, updateTicketField } from "@/server/domain/ticket/edit";

import { execBoth, prepareSnapshot, resetWorkingDatabases } from "./lib/harness";
import { both } from "./lib/ticketedit";

/**
 * Modifica del ticket (area "ticketedit"): Ticket::update (form "Modifica"), Ticket::updateField
 * (ajax editField) e Ticket::changeOwner, confrontati con il PHP originale.
 */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

const FUTURE = "2027-01-15 14:30";

/**
 * Agente 1 in un fuso diverso da quello di sistema (Europe/Rome); campo data e campo testo obbligatorio
 * per l'agente (già compilato) aggiunti al form del ticket 3. Senza orario lavorativo predefinito: la
 * scadenza stimata con un orario "floating" dipende dal fuso dell'agente (updateEstDueDate non lo passa
 * ancora a slaDueDate, fuori da questi scenari).
 */
const extraFieldsSql = [
  "UPDATE {p}staff SET timezone = 'America/New_York' WHERE staff_id = 1",
  "UPDATE {p}config SET value = '0' WHERE namespace = 'core' AND `key` = 'schedule_id'",
  `INSERT INTO {p}form_field (id, form_id, flags, type, label, name, configuration, sort, hint, created, updated) VALUES
    (74, 2, 13057, 'datetime', 'Intervento', 'intervento', '{"time":true}', 4, '', NOW(), NOW()),
    (75, 2, 29441, 'text', 'Reparto', 'reparto', '{}', 5, '', NOW(), NOW())`,
  "INSERT INTO {p}form_entry_values (entry_id, field_id, value) VALUES (23, 74, NULL), (23, 75, 'Cardiologia')",
];

describe("Ticket::update (form di modifica)", () => {
  it("modifica topic, SLA, origine, scadenza, proprietario, campi e nota (con avviso)", async () => {
    await execBoth("UPDATE {p}config SET value = '1' WHERE namespace = 'core' AND `key` = 'note_alert_active'");
    const post = {
      topicId: "2",
      slaId: "0",
      source: "Email",
      duedate: FUTURE,
      user_id: "5",
      note: "<p>Aggiornato per <b>richiesta</b> del reparto</p>",
      subject: "Nuovo oggetto",
      priority: "3",
    };
    const r = await both(
      "ticketedit.update",
      { agent: 1, ticket: 3, post },
      (ctx) =>
        updateTicket(ctx, {
          ticketId: 3,
          topicId: post.topicId,
          slaId: post.slaId,
          source: post.source,
          duedate: post.duedate,
          userId: post.user_id,
          note: post.note,
          vars: { subject: post.subject, priority: post.priority },
        }),
      1,
    );
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });

  it("solo l'oggetto cambia, SLA transitorio riselezionato dal topic", async () => {
    await execBoth(
      "INSERT INTO {p}sla (id, schedule_id, flags, grace_period, name, notes, created, updated) VALUES (2, 0, 9, 4, 'Transient', '', NOW(), NOW())",
      "UPDATE {p}ticket SET sla_id = 2 WHERE ticket_id = 3",
    );
    const post = { topicId: "11", slaId: "2", source: "Phone", duedate: "", user_id: "10", note: "", subject: "Solo l'oggetto", priority: "1" };
    const r = await both("ticketedit.update", { agent: 1, ticket: 3, post }, (ctx) =>
      updateTicket(ctx, {
        ticketId: 3,
        topicId: post.topicId,
        slaId: post.slaId,
        source: post.source,
        duedate: post.duedate,
        userId: post.user_id,
        note: post.note,
        vars: { subject: post.subject, priority: post.priority },
      }),
    );
    expect(r.ts).toEqual({ ok: true });
  });

  it("nessuna modifica: niente evento, solo la scadenza stimata ricalcolata", async () => {
    const post = { topicId: "11", slaId: "1", source: "Phone", duedate: "", user_id: "10", note: "", subject: "Richiesta nuovo account per specializzando", priority: "1" };
    const r = await both("ticketedit.update", { agent: 1, ticket: 3, post }, (ctx) =>
      updateTicket(ctx, {
        ticketId: 3,
        topicId: post.topicId,
        slaId: post.slaId,
        source: post.source,
        duedate: post.duedate,
        userId: post.user_id,
        vars: { subject: post.subject, priority: post.priority },
      }),
    );
    expect(r.ts).toEqual({ ok: true });
  });

  it("errore: scadenza nel passato e oggetto vuoto, nessuna scrittura", async () => {
    const post = { topicId: "11", slaId: "1", source: "Phone", duedate: "2020-01-01 10:00", user_id: "10", note: "<p>x</p>", subject: "", priority: "1" };
    const r = await both("ticketedit.update", { agent: 1, ticket: 3, post }, (ctx) =>
      updateTicket(ctx, {
        ticketId: 3,
        topicId: post.topicId,
        slaId: post.slaId,
        source: post.source,
        duedate: post.duedate,
        userId: post.user_id,
        note: post.note,
        vars: { subject: post.subject, priority: post.priority },
      }),
    );
    expect(r.php.ok).toBe(false);
    expect(r.ts).toMatchObject({ error: "invalid" });
  });

  it("campo data nel fuso dell'agente; campo obbligatorio assente dal POST mantiene la risposta", async () => {
    await execBoth(...extraFieldsSql);
    const post = { topicId: "11", slaId: "1", source: "Phone", duedate: "", user_id: "10", note: "", subject: "Richiesta nuovo account per specializzando", priority: "1", intervento: "2026-11-03 14:30" };
    const r = await both("ticketedit.update", { agent: 1, ticket: 3, post }, (ctx) =>
      updateTicket(ctx, {
        ticketId: 3,
        topicId: post.topicId,
        slaId: post.slaId,
        source: post.source,
        duedate: post.duedate,
        userId: post.user_id,
        vars: { subject: post.subject, priority: post.priority, intervento: post.intervento },
      }),
    );
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });

  it("negato senza permesso ticket.edit (Limited Access)", async () => {
    const post = { topicId: "2", slaId: "1", source: "Phone", duedate: "", user_id: "", note: "", subject: "x", priority: "1" };
    const r = await both("ticketedit.update", { agent: 4, ticket: 3, post }, (ctx) =>
      updateTicket(ctx, { ticketId: 3, topicId: "2", slaId: "1", source: "Phone", duedate: "", vars: { subject: "x", priority: "1" } }),
    );
    expect(r.php.ok).toBe(false);
    expect(r.ts).toHaveProperty("error");
  });
});

describe("Ticket::updateField (modifica di un campo)", () => {
  it("priorità con commento", async () => {
    const r = await both("ticketedit.field", { agent: 1, ticket: 3, field: "priority", post: { priority: "4", comments: "<p>Urgente</p>" } }, (ctx) =>
      updateTicketField(ctx, { ticketId: 3, field: "priority", vars: { priority: "4" }, comments: "<p>Urgente</p>" }),
    );
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });

  it("oggetto (campo per id) senza commento", async () => {
    const r = await both("ticketedit.field", { agent: 1, ticket: 3, field: "20", post: { subject: "Altro oggetto", comments: "" } }, (ctx) =>
      updateTicketField(ctx, { ticketId: 3, field: "20", vars: { subject: "Altro oggetto" } }),
    );
    expect(r.ts).toEqual({ ok: true });
  });

  it("help topic con commento", async () => {
    const r = await both("ticketedit.field", { agent: 2, ticket: 3, field: "topic", post: { topic_id: "10", comments: "<p>Era un guasto</p>" } }, (ctx) =>
      updateTicketField(ctx, { ticketId: 3, field: "topic", vars: { topic_id: "10" }, comments: "<p>Era un guasto</p>" }),
    );
    expect(r.ts).toEqual({ ok: true });
  });

  it("piano SLA con ricalcolo della scadenza stimata", async () => {
    await execBoth("INSERT INTO {p}sla (id, schedule_id, flags, grace_period, name, notes, created, updated) VALUES (2, 0, 1, 4, 'Fast', '', NOW(), NOW())");
    const r = await both("ticketedit.field", { agent: 1, ticket: 3, field: "sla", post: { sla_id: "2" } }, (ctx) =>
      updateTicketField(ctx, { ticketId: 3, field: "sla", vars: { sla_id: "2" } }),
    );
    expect(r.ts).toEqual({ ok: true });
  });

  it("scadenza", async () => {
    const r = await both("ticketedit.field", { agent: 1, ticket: 3, field: "duedate", post: { duedate: FUTURE } }, (ctx) =>
      updateTicketField(ctx, { ticketId: 3, field: "duedate", vars: { duedate: FUTURE } }),
    );
    expect(r.ts).toEqual({ ok: true });
  });

  it("origine", async () => {
    const r = await both("ticketedit.field", { agent: 1, ticket: 3, field: "source", post: { source: "Other" } }, (ctx) =>
      updateTicketField(ctx, { ticketId: 3, field: "source", vars: { source: "Other" } }),
    );
    expect(r.ts).toEqual({ ok: true });
  });

  it("campo data (per id) nel fuso dell'agente", async () => {
    await execBoth(...extraFieldsSql);
    const r = await both("ticketedit.field", { agent: 1, ticket: 3, field: "74", post: { intervento: "2026-11-03 14:30", comments: "" } }, (ctx) =>
      updateTicketField(ctx, { ticketId: 3, field: "74", vars: { intervento: "2026-11-03 14:30" } }),
    );
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });

  it("campo obbligatorio assente dal POST: valido (risposta attuale), salvato il valore nullo del widget", async () => {
    await execBoth(...extraFieldsSql);
    const r = await both("ticketedit.field", { agent: 1, ticket: 3, field: "75", post: { comments: "" } }, (ctx) =>
      updateTicketField(ctx, { ticketId: 3, field: "75", vars: {} }),
    );
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });

  it("valore già impostato: errore senza scritture", async () => {
    const r = await both("ticketedit.field", { agent: 1, ticket: 3, field: "priority", post: { priority: "1" } }, (ctx) =>
      updateTicketField(ctx, { ticketId: 3, field: "priority", vars: { priority: "1" } }),
    );
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "already_set" });
  });
});

describe("Ticket::changeOwner", () => {
  it("cambia proprietario e rimuove il nuovo proprietario dai collaboratori", async () => {
    await execBoth("INSERT INTO {p}thread_collaborator (flags, thread_id, user_id, role, created, updated) VALUES (3, 3, 5, 'M', NOW(), NOW())");
    const r = await both("ticketedit.changeuser", { agent: 1, ticket: 3, user_id: 5 }, (ctx) => changeTicketOwner(ctx, { ticketId: 3, userId: 5 }));
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });
});
