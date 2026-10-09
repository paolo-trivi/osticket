import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb } from "@/server/db";
import { mergeTickets, unlinkTickets } from "@/server/domain/ticket/merge";

import { execBoth, prepareSnapshot, resetWorkingDatabases } from "./lib/harness";
import { both } from "./lib/ticketedit";

/** Unione (merge) e collegamento (link) dei ticket, scollegamento (area "ticketedit"). */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

// Numeri dei ticket della fixture
const N1 = "247301";
const N3 = "636845";
const N4 = "958530";
const N5 = "926134";

const LINKED = [
  "UPDATE {p}ticket SET flags = 0x18, sort = 0 WHERE ticket_id = 1",
  "UPDATE {p}ticket SET ticket_pid = 1, flags = 0x8, sort = 1 WHERE ticket_id = 3",
  "UPDATE {p}ticket SET ticket_pid = 1, flags = 0x8, sort = 2 WHERE ticket_id = 4",
];

describe("link", () => {
  it("collega tre ticket al primo", async () => {
    const post = { title: "link", tids: [N1, N3, N4], combine: "2" };
    const r = await both("ticketedit.merge", { agent: 1, post }, (ctx) => mergeTickets(ctx, { title: "link", numbers: post.tids, combine: "2" }));
    expect(r.ts).toMatchObject({ ok: true });
  });

  it("aggiunge un ticket a un link esistente", async () => {
    await execBoth(...LINKED);
    const post = { title: "link", tids: [N1, N3, N4, N5], combine: "2" };
    const r = await both("ticketedit.merge", { agent: 1, post }, (ctx) => mergeTickets(ctx, { title: "link", numbers: post.tids, combine: "2" }));
    expect(r.ts).toMatchObject({ ok: true });
  });

  it("scollega un figlio (il padre resta padre)", async () => {
    await execBoth(...LINKED);
    const r = await both("ticketedit.merge", { agent: 1, post: { dtids: [3] } }, (ctx) => unlinkTickets(ctx, { ticketIds: [3] }));
    expect(r.ts).toEqual({ ok: true });
  });

  it("scollega il padre: tutti i figli tornano indipendenti", async () => {
    await execBoth(...LINKED);
    const r = await both("ticketedit.merge", { agent: 1, post: { dtids: [1] } }, (ctx) => unlinkTickets(ctx, { ticketIds: [1] }));
    expect(r.ts).toEqual({ ok: true });
  });

  it("link negato senza permesso ticket.link (View only)", async () => {
    await execBoth("UPDATE {p}staff SET assigned_only = 0 WHERE staff_id = 5");
    const post = { title: "link", tids: [N1, N3], combine: "2" };
    const r = await both("ticketedit.merge", { agent: 5, post }, (ctx) => mergeTickets(ctx, { title: "link", numbers: post.tids, combine: "2" }));
    expect(r.php.ok).toBe(false);
    expect(r.ts).toHaveProperty("error");
  });
});

describe("merge", () => {
  it("thread combinati: collaboratori, referral di reparto, voci spostate, figlio chiuso, task spostati", async () => {
    await execBoth(
      "INSERT INTO {p}thread_collaborator (flags, thread_id, user_id, role, created, updated) VALUES (3, 4, 5, 'M', '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
      "INSERT INTO {p}task (object_id, object_type, number, dept_id, staff_id, team_id, lock_id, flags, duedate, closed, created, updated) VALUES (4, 'T', '999', 3, 0, 0, 0, 1, NULL, NULL, '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
    );
    const post = { title: "merge", tids: [N1, N4], combine: "1", participants: "all", childStatusId: "3", parentStatusId: "", "move-tasks": "on" };
    const r = await both("ticketedit.merge", { agent: 1, post }, (ctx) =>
      mergeTickets(ctx, { title: "merge", numbers: post.tids, combine: "1", participants: "all", childStatusId: 3, moveTasks: true }),
    );
    expect(r.php.ok).toBe(true);
    expect(r.ts).toMatchObject({ ok: true });
  });

  it("thread separati con stato del padre ed eliminazione del figlio", async () => {
    const post = { title: "merge", tids: [N3, N1], combine: "0", participants: "user", childStatusId: "2", parentStatusId: "1", "delete-child": "on" };
    const r = await both("ticketedit.merge", { agent: 1, post }, (ctx) =>
      mergeTickets(ctx, { title: "merge", numbers: post.tids, combine: "0", participants: "user", childStatusId: 2, parentStatusId: 1, deleteChild: true }),
    );
    expect(r.ts).toMatchObject({ ok: true });
  });

  it("da link a merge: il link viene sciolto e i ticket uniti", async () => {
    await execBoth(...LINKED);
    const post = { title: "merge", tids: [N1, N3], combine: "1", participants: "all", childStatusId: "3", parentStatusId: "" };
    const r = await both("ticketedit.merge", { agent: 1, post }, (ctx) =>
      mergeTickets(ctx, { title: "merge", numbers: post.tids, combine: "1", participants: "all", childStatusId: 3 }),
    );
    expect(r.ts).toMatchObject({ ok: true });
  });
});
