import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb } from "@/server/db";
import { deleteTicket, ticketHardDelete } from "@/server/domain/ticket/delete";
import { TicketRecord } from "@/server/domain/ticket/record";
import { changeTicketStatus } from "@/server/domain/ticket/ticket-state";

import { execBoth, prepareSnapshot, resetWorkingDatabases } from "./lib/harness";
import { both } from "./lib/ticketedit";

/**
 * Eliminazione definitiva dei ticket (area "ticketedit"): stato "deleted" da ajax setTicketStatus
 * (Ticket::setStatus → Ticket::delete) e Ticket::delete diretto (azione di massa).
 */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

const DELETED = 5;

/** Ticket 3 e 4 collegati (link) al padre 1. */
const LINKED = [
  "UPDATE {p}ticket SET flags = 0x18, sort = 0 WHERE ticket_id = 1",
  "UPDATE {p}ticket SET ticket_pid = 1, flags = 0x8, sort = 1 WHERE ticket_id = 3",
  "UPDATE {p}ticket SET ticket_pid = 1, flags = 0x8, sort = 2 WHERE ticket_id = 4",
];

describe("eliminazione da cambio stato", () => {
  it("elimina un ticket con collaboratori, referral, bozze, lock ed eventi", async () => {
    await execBoth(
      "INSERT INTO {p}thread_collaborator (flags, thread_id, user_id, role, created, updated) VALUES (3, 2, 5, 'M', NOW(), NOW())",
      "INSERT INTO {p}draft (staff_id, namespace, body, extra, created, updated) VALUES (1, 'ticket.response.2', 'x', NULL, NOW(), NOW())",
      "INSERT INTO {p}lock (staff_id, expire, code, created) VALUES (1, NOW() + INTERVAL 1 HOUR, 'abc', NOW())",
      "UPDATE {p}ticket SET lock_id = LAST_INSERT_ID() WHERE ticket_id = 2",
    );
    const args = { agent: 1, ticket: 2, status_id: DELETED, comments: "<p>Spam</p>" };
    const r = await both("ticketedit.status", args, (ctx) =>
      changeTicketStatus(ctx, { ticketId: 2, statusId: DELETED, comments: args.comments }, { hardDelete: ticketHardDelete() }),
    );
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true });
  });

  it("elimina con allegati (file orfani), header email e log di debug", async () => {
    await execBoth(
      "UPDATE {p}config SET value = '3' WHERE namespace = 'core' AND `key` = 'log_level'",
      "INSERT INTO {p}file (id, ft, bk, type, size, `key`, signature, name, attrs, created) VALUES (50, 'T', 'D', 'text/plain', 3, 'k50', 's50', 'a.txt', NULL, NOW() - INTERVAL 2 DAY)",
      "INSERT INTO {p}file_chunk (file_id, chunk_id, filedata) VALUES (50, 0, 'abc')",
      "INSERT INTO {p}attachment (object_id, type, file_id, name, inline, lang) VALUES (3, 'H', 50, NULL, 0, NULL)",
      "INSERT INTO {p}file (id, ft, bk, type, size, `key`, signature, name, attrs, created) VALUES (51, 'T', 'D', 'text/plain', 3, 'k51', 's51', 'b.txt', NULL, NOW())",
      "INSERT INTO {p}file (id, ft, bk, type, size, `key`, signature, name, attrs, created) VALUES (52, 'T', 'D', 'text/plain', 3, 'k52', 's52', 'c.txt', NULL, NOW() - INTERVAL 3 DAY)",
      "INSERT INTO {p}thread_entry_email (thread_entry_id, mid, headers) VALUES (2, '<x@y>', 'From: a@b')",
    );
    const args = { agent: 1, ticket: 2, status_id: DELETED, comments: "<p>Duplicato <b>vecchio</b></p>" };
    const r = await both("ticketedit.status", args, (ctx) =>
      changeTicketStatus(ctx, { ticketId: 2, statusId: DELETED, comments: args.comments }, { hardDelete: ticketHardDelete() }),
    );
    expect(r.ts).toEqual({ ok: true });
  });

  it("elimina il padre di un link insieme ai figli", async () => {
    await execBoth(...LINKED);
    const args = { agent: 1, ticket: 1, status_id: DELETED, children: true };
    const r = await both("ticketedit.status", args, (ctx) =>
      changeTicketStatus(ctx, { ticketId: 1, statusId: DELETED, children: true }, { hardDelete: ticketHardDelete({ children: true }) }),
    );
    expect(r.ts).toEqual({ ok: true });
  });

  it("elimina il padre di un link senza i figli: i figli tornano indipendenti", async () => {
    await execBoth(...LINKED);
    const args = { agent: 1, ticket: 1, status_id: DELETED };
    const r = await both("ticketedit.status", args, (ctx) =>
      changeTicketStatus(ctx, { ticketId: 1, statusId: DELETED }, { hardDelete: ticketHardDelete() }),
    );
    expect(r.ts).toEqual({ ok: true });
  });

  it("eliminazione negata senza permesso ticket.delete", async () => {
    const args = { agent: 2, ticket: 3, status_id: DELETED };
    const r = await both("ticketedit.status", args, (ctx) =>
      changeTicketStatus(ctx, { ticketId: 3, statusId: DELETED }, { hardDelete: ticketHardDelete() }),
    );
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "denied" });
  });
});

describe("Ticket::delete diretto", () => {
  it("elimina un figlio di un merge combinato: il padre torna normale, il thread resta", async () => {
    await execBoth(
      "UPDATE {p}ticket SET flags = 0x11 WHERE ticket_id = 1",
      "UPDATE {p}ticket SET ticket_pid = 1, flags = 0x1, sort = 1 WHERE ticket_id = 3",
      "UPDATE {p}thread SET object_type = 'C', extra = '{\"ticket_id\":1,\"number\":\"636845\"}' WHERE object_type = 'T' AND object_id = 3",
    );
    const args = { agent: 1, ticket: 3, comments: "" };
    const r = await both("ticketedit.delete", args, async (ctx) => {
      const rec = await TicketRecord.load(ctx.tx, 3, true);
      return deleteTicket(ctx, rec!, "");
    });
    expect(r.php.ok).toBe(true);
    expect(r.ts).toBe(true);
  });
});
