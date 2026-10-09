import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb } from "@/server/db";
import { massAssign, massChangeStatus, massClaim, massDelete, massTransfer } from "@/server/domain/ticket/mass";

import { execBoth, prepareSnapshot, resetWorkingDatabases } from "./lib/harness";
import { both } from "./lib/ticketedit";

/** Azioni di massa dalla lista dei ticket (massProcess, setSelectedTicketsStatus). */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

describe("azioni di massa", () => {
  it("assegna più ticket a un agente con commento (avvisi)", async () => {
    const post = { tids: [1, 9, 18], assignee: "s3", comments: "<p>Di massa</p>" };
    const r = await both("ticketedit.mass", { agent: 1, action: "assign", what: "agents", post }, (ctx) =>
      massAssign(ctx, { ticketIds: post.tids, assignee: "s3", comments: post.comments }),
      3,
    );
    expect(r.php.ok).toBe(true);
    expect(r.ts).toEqual({ ok: true, count: 3, total: 3 });
  });

  it("assegna a un team", async () => {
    const post = { tids: [1, 9], assignee: "t1" };
    const r = await both("ticketedit.mass", { agent: 1, action: "assign", what: "teams", post }, (ctx) => massAssign(ctx, { ticketIds: post.tids, assignee: "t1" }));
    expect(r.ts).toMatchObject({ ok: true, count: 2 });
  });

  it("presa in carico di massa, anche di un ticket già assegnato", async () => {
    const post = { tids: [1, 3, 9], comments: "" };
    const r = await both("ticketedit.mass", { agent: 2, action: "claim", post }, (ctx) => massClaim(ctx, { ticketIds: post.tids }));
    expect(r.php.ok).toBe(true);
    expect(r.ts).toMatchObject({ ok: true, count: 3 });
  });

  it("trasferisce più ticket", async () => {
    const post = { tids: [1, 3, 11], dept: "2", comments: "<p>Al commerciale</p>" };
    const r = await both("ticketedit.mass", { agent: 1, action: "transfer", post }, (ctx) => massTransfer(ctx, { ticketIds: post.tids, deptId: 2, comments: post.comments }));
    expect(r.ts).toMatchObject({ ok: true, count: 3 });
  });

  it("elimina più ticket con motivo", async () => {
    await execBoth("UPDATE {p}config SET value = '3' WHERE namespace = 'core' AND `key` = 'log_level'");
    const post = { tids: [2, 5], comments: "Duplicati" };
    const r = await both("ticketedit.mass", { agent: 1, action: "delete", post }, (ctx) => massDelete(ctx, { ticketIds: post.tids, comments: post.comments }));
    expect(r.ts).toEqual({ ok: true, count: 2, total: 2 });
  });

  it("eliminazione di massa negata senza permesso", async () => {
    const post = { tids: [2, 5], comments: "" };
    const r = await both("ticketedit.mass", { agent: 2, action: "delete", post }, (ctx) => massDelete(ctx, { ticketIds: post.tids }));
    expect(r.php.ok).toBe(false);
    expect(r.ts).toEqual({ error: "denied" });
  });

  it("chiude più ticket con commento: dopo un ticket non chiudibile falliscono anche i successivi", async () => {
    // 1 ha un task aperto: 3 e 6 vengono chiusi, 1 fallisce e blocca 11 ($errors condiviso nel PHP)
    const args = { agent: 1, tids: [3, 6, 1, 11], status_id: 3, comments: "<p>Chiusura di massa</p>" };
    const r = await both("ticketedit.mass.status", args, (ctx) => massChangeStatus(ctx, { ticketIds: args.tids, statusId: 3, comments: args.comments }));
    expect(r.php.count).toBe(2);
    expect(r.ts).toMatchObject({ ok: true, count: 2 });
  });

  it("assegnazione di massa: un ticket già assegnato all'agente non blocca gli altri", async () => {
    // 11 è già assegnato a Laura (3): 1 e 9 vengono assegnati
    const post = { tids: [1, 11, 9], assignee: "s3" };
    const r = await both("ticketedit.mass", { agent: 1, action: "assign", what: "agents", post }, (ctx) => massAssign(ctx, { ticketIds: post.tids, assignee: "s3" }), 2);
    expect(r.php.count).toBe(2);
    expect(r.ts).toMatchObject({ ok: true, count: 2 });
  });

  it("trasferimento di massa: dopo un ticket già nel reparto falliscono anche i successivi", async () => {
    // 4 è già nel reparto 3: 1 viene trasferito, 4 fallisce e blocca 3
    const post = { tids: [1, 4, 3], dept: "3" };
    const r = await both("ticketedit.mass", { agent: 1, action: "transfer", post }, (ctx) => massTransfer(ctx, { ticketIds: post.tids, deptId: 3 }));
    expect(r.php.count).toBe(1);
    expect(r.ts).toMatchObject({ ok: true, count: 1 });
  });

  it("riapre più ticket", async () => {
    const args = { agent: 1, tids: [2, 5, 16], status_id: 1 };
    const r = await both("ticketedit.mass.status", args, (ctx) => massChangeStatus(ctx, { ticketIds: args.tids, statusId: 1 }));
    expect(r.ts).toMatchObject({ ok: true, count: 3 });
  });

  it("elimina tramite lo stato Deleted", async () => {
    const args = { agent: 1, tids: [2, 5], status_id: 5, comments: "Spam" };
    const r = await both("ticketedit.mass.status", args, (ctx) => massChangeStatus(ctx, { ticketIds: args.tids, statusId: 5, comments: args.comments }));
    expect(r.ts).toMatchObject({ ok: true, count: 2 });
  });
});
