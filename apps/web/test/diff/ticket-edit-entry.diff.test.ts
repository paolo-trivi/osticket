import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb } from "@/server/db";
import { editThreadEntry } from "@/server/domain/thread/edit";

import { execBoth, prepareSnapshot, resetWorkingDatabases } from "./lib/harness";
import { both } from "./lib/ticketedit";

/** Modifica delle voci del thread (TEA_EditThreadEntry / Edit and Resend senza reinvio). */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

describe("modifica di una voce del thread", () => {
  it("risposta di un altro agente (thread.edit): nuova versione, allegati spostati, originale nascosto", async () => {
    await execBoth("INSERT INTO {p}attachment (object_id, type, file_id, name, inline, lang) VALUES (3, 'H', 2, NULL, 0, NULL), (3, 'H', 1, NULL, 1, NULL)");
    const args = { agent: 1, ticket: 2, entry: 3, body: "<p>Testo <b>corretto</b></p>", title: "Nuovo & titolo" };
    const r = await both("ticketedit.entry.edit", args, (ctx) => editThreadEntry(ctx, { ticketId: 2, entryId: 3, body: args.body, title: args.title }));
    expect(r.php.ok).toBe(true);
    expect(r.ts).toMatchObject({ ok: true });
  });

  it("messaggio dell'utente", async () => {
    const args = { agent: 1, ticket: 2, entry: 2, body: "<p>Il badge non apre il varco.</p><p></p>" };
    const r = await both("ticketedit.entry.edit", args, (ctx) => editThreadEntry(ctx, { ticketId: 2, entryId: 2, body: args.body }));
    expect(r.ts).toMatchObject({ ok: true });
  });

  it("seconda modifica dello stesso agente: sostituisce la precedente", async () => {
    await execBoth(
      "INSERT INTO {p}thread_entry (id, pid, thread_id, staff_id, user_id, type, flags, poster, editor, editor_type, source, title, body, format, ip_address, extra, recipients, created, updated) " +
        "VALUES (500, 3, 2, 2, 0, 'R', 578, 'Mario Rossi', 2, 'S', '', NULL, 'Prima modifica', 'html', '10.0.0.1', NULL, NULL, '2026-08-11 05:59:14', '2026-09-01 10:00:00')",
      "UPDATE {p}thread_entry SET flags = flags | 4 WHERE id = 3",
      "INSERT INTO {p}_search (object_type, object_id, title, content) VALUES ('H', 500, '', 'Prima modifica')",
    );
    const args = { agent: 2, ticket: 2, entry: 500, body: "<p>Seconda modifica</p>" };
    const r = await both("ticketedit.entry.edit", args, (ctx) => editThreadEntry(ctx, { ticketId: 2, entryId: 500, body: args.body }));
    expect(r.ts).toMatchObject({ ok: true });
  });

  it("corpo invariato: nessuna scrittura", async () => {
    const args = { agent: 1, ticket: 2, entry: 4, body: "Il problema si ripresenta dopo pranzo." };
    const r = await both("ticketedit.entry.edit", args, (ctx) => editThreadEntry(ctx, { ticketId: 2, entryId: 4, body: args.body }));
    expect(r.ts).toMatchObject({ ok: true, unchanged: true });
  });

  it("negato: voce di un altro agente senza thread.edit", async () => {
    const args = { agent: 4, ticket: 3, entry: 6, body: "<p>x</p>" };
    const r = await both("ticketedit.entry.edit", args, (ctx) => editThreadEntry(ctx, { ticketId: 3, entryId: 6, body: args.body }));
    expect(r.php.ok).toBe(false);
    expect(r.ts).toHaveProperty("error");
  });
});
