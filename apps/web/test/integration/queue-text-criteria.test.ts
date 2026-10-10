import { afterAll, describe, expect, it } from "vitest";

import { closeDb, db } from "@/server/db";
import { listQueueTickets } from "@/server/domain/queue/engine";
import { adhocQueue, quickSearchCriteria } from "@/server/domain/queue/queues";
import type { Criterion } from "@/server/domain/queue/fields";
import { loadAgent } from "@/server/domain/staff/staff";

afterAll(closeDb);

/**
 * Criteri sui campi di testo (TextboxField::getSearchQ): ticket di un utente, ricerca rapida per numero
 * ed email. Prima venivano scartati in silenzio e la lista mostrava tutti i ticket.
 */
describe("criteri sui campi di testo", () => {
  it("filtrano davvero: utente, utente + stato, numero, email", async () => {
    const agent = (await loadAgent(1, db()))!;
    const ids = async (c: Criterion[]) =>
      (await listQueueTickets(agent, adhocQueue(agent, c, ""), { page: 1, pageSize: 500 }, { userTz: "Europe/Rome" })).ids;
    const sample = await db().selectFrom("ticket").select(["user_id", "number"]).orderBy("ticket_id").executeTakeFirstOrThrow();
    const ofUser = (await db().selectFrom("ticket").select("ticket_id").where("user_id", "=", sample.user_id).execute()).map((r) => r.ticket_id);
    const withNumber = (await db().selectFrom("ticket").select("ticket_id").where("number", "like", `%${sample.number ?? ""}%`).execute()).map((r) => r.ticket_id);
    const sorted = (a: number[]) => [...a].sort((x, y) => x - y);

    expect(sorted(await ids([["user_id", "equal", sample.user_id]]))).toEqual(sorted(ofUser));
    const open = await ids([["user_id", "equal", sample.user_id], ["status__state", "includes", { open: "open" }]]);
    expect(open.every((id) => ofUser.includes(id))).toBe(true);
    expect(sorted(await ids(quickSearchCriteria(sample.number ?? "")!))).toEqual(sorted(withNumber));
  });
});
