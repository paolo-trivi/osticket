/**
 * Board Kanban sul DB di sviluppo (sola lettura): la composizione della board corrisponde alla coda sorgente
 * (stessi ticket di listQueueTickets, il motore della lista) e non mostra mai ticket fuori dalla visibilità
 * dell'agente.
 */
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_BOARD_PARAMS, type BoardParams } from "@/server/domain/board/params";
import type { BoardData } from "@/server/domain/board/types";

const { closeDb, db, table } = await import("@/server/db");
const { detectDbTimezone } = await import("@/server/db/time");
const { loadAgent } = await import("@/server/domain/staff/staff");
const { adhocQueue, listQueueTickets, loadQueues, quickSearchCriteria, visibilitySql } = await import("@/server/domain/queue/engine");
const { agentTimeZone } = await import("@/server/format/datetime");
const { loadBoard, loadBoardCell, boardSources } = await import("@/server/domain/board/board");
const { ticketStatusChoices } = await import("@/server/domain/ticket/ticket-state");

type Agent = NonNullable<Awaited<ReturnType<typeof loadAgent>>>;
type Queue = Parameters<typeof listQueueTickets>[1];

let agents: Agent[] = [];

beforeAll(async () => {
  // come currentAgent(): il fuso del DB serve a date e criteri delle code
  await detectDbTimezone(db());
  const staff = await db().selectFrom("staff").select("staff_id").where("isactive", "=", 1).orderBy("staff_id").execute();
  agents = (await Promise.all(staff.map((s) => loadAgent(s.staff_id)))).filter((a): a is Agent => !!a);
  expect(agents.length).toBeGreaterThan(1);
});

afterAll(closeDb);

const params = (p: Partial<BoardParams>): BoardParams => ({ ...DEFAULT_BOARD_PARAMS, ...p });

/** Tutti gli id della board, caricando anche le card oltre la prima pagina di ogni cella. */
async function allBoardIds(agent: Agent, p: BoardParams, board: BoardData): Promise<number[]> {
  const ids: number[] = [];
  for (const lane of board.lanes) {
    for (const col of board.columns) {
      const cell = board.cells[`${lane.key}::${col.key}`];
      if (!cell) continue;
      ids.push(...cell.cards.map((c) => c.id));
      let offset = cell.cards.length;
      while (offset < cell.total) {
        const more = await loadBoardCell(agent, p, "it", { lane: lane.key, col: col.key, offset, limit: 100 });
        if ("error" in more) throw new Error(more.error);
        expect(more.total).toBe(cell.total);
        ids.push(...more.cards.map((c) => c.id));
        offset += more.cards.length;
        if (!more.cards.length) break;
      }
    }
  }
  return ids.sort((a, b) => a - b);
}

/** Tutti gli id della lista della coda (listQueueTickets, tutte le pagine). */
async function listIds(agent: Agent, queue: Queue): Promise<number[]> {
  const userTz = await agentTimeZone(agent);
  const ids: number[] = [];
  for (let page = 1; ; page++) {
    const r = await listQueueTickets(agent, queue, { page, pageSize: 100 }, { userTz });
    ids.push(...r.ids);
    if (r.ids.length < 100) break;
  }
  return ids.sort((a, b) => a - b);
}

/** Ticket open/closed visibili all'agente, senza figli di merge (sorgente "tutti i ticket visibili"). */
async function visibleIds(agent: Agent): Promise<number[]> {
  const { rows } = await sql<{ ticket_id: number }>`SELECT T.ticket_id FROM ${table("ticket")} T
    INNER JOIN ${table("ticket_status")} ST ON (ST.id = T.status_id)
    WHERE ST.state IN ('open', 'closed') AND (T.ticket_pid IS NULL OR (T.flags & 8) != 0) AND ${visibilitySql(agent, false)}`.execute(db());
  return rows.map((r) => Number(r.ticket_id)).sort((a, b) => a - b);
}

describe("board: composizione sul DB di sviluppo", () => {
  it("ogni coda navigabile (con chiusi meno recenti) = stessi ticket della lista della coda, per ogni agente", async () => {
    const all = await loadQueues();
    let compared = 0;
    for (const agent of agents) {
      const sources = await boardSources(agent);
      expect(sources.length).toBeGreaterThan(0);
      for (const s of sources) {
        const queue = all.get(Number(s.value))!;
        for (const group of ["priority", "status"] as const) {
          const p = params({ source: queue.id, group, older: true });
          const board = await loadBoard(agent, p, "it");
          expect(board.error).toBeUndefined();
          // la board mostra solo ticket open/closed: la lista può contenere archiviati/eliminati
          const ids = await allBoardIds(agent, p, board);
          expect(new Set(ids).size).toBe(ids.length);
          const expected = await listIds(agent, queue);
          const { rows } = expected.length
            ? await sql<{ ticket_id: number }>`SELECT T.ticket_id FROM ${table("ticket")} T
                INNER JOIN ${table("ticket_status")} ST ON (ST.id = T.status_id)
                WHERE ST.state IN ('open', 'closed') AND T.ticket_id IN (${sql.join(expected)})`.execute(db())
            : { rows: [] };
          expect({ agent: agent.id, queue: queue.id, group, ids }).toEqual({
            agent: agent.id,
            queue: queue.id,
            group,
            ids: rows.map((r) => Number(r.ticket_id)).sort((a, b) => a - b),
          });
          expect(board.total).toBe(ids.length);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(10);
  }, 120_000);

  it("sorgente 'tutti': solo e tutti i ticket visibili (visibilitySql + filtro merge), per ogni agente", async () => {
    for (const agent of agents) {
      for (const group of ["assignee", "dept", "priority", "status"] as const) {
        const p = params({ group, older: true });
        const board = await loadBoard(agent, p, "it");
        expect(await allBoardIds(agent, p, board)).toEqual(await visibleIds(agent));
      }
    }
  }, 120_000);

  it("swimlane per assegnatario: celle coerenti con le chiavi", async () => {
    const agent = agents[0];
    const p = params({ group: "priority", lane: "assignee", older: true });
    const board = await loadBoard(agent, p, "it");
    expect(await allBoardIds(agent, p, board)).toEqual(await visibleIds(agent));
    for (const [key, cell] of Object.entries(board.cells)) {
      const [lane, col] = key.split("::");
      for (const c of cell.cards) {
        expect(c.lane).toBe(lane);
        expect(c.col).toBe(col);
        expect(c.lane).toBe(c.assignee ? `${c.assignee.kind === "staff" ? "s" : "t"}${c.assignee.id}` : "u");
        expect(c.col).toBe(String(c.priority?.id ?? 0));
      }
      expect(cell.cards.length).toBeLessThanOrEqual(board.perCell);
    }
    // "Non assegnato" come ultima swimlane
    const unassigned = board.lanes.findIndex((l) => l.special === "unassigned");
    if (unassigned >= 0) expect(unassigned).toBe(board.lanes.length - 1);
  });

  it("filtri rapidi: solo miei, non assegnati, scaduti, priorità", async () => {
    const agent = agents[0];
    const cards = (b: BoardData) => Object.values(b.cells).flatMap((c) => c.cards);
    for (const c of cards(await loadBoard(agent, params({ group: "priority", mine: true, older: true }), "it")))
      expect(c.assignee).toEqual(expect.objectContaining({ kind: "staff", id: agent.id }));
    const un = await loadBoard(agent, params({ group: "assignee", unassigned: true }), "it");
    expect(un.columns.every((c) => c.special === "unassigned")).toBe(true);
    for (const c of cards(await loadBoard(agent, params({ group: "priority", overdue: true }), "it"))) expect(c.overdue).toBe(true);
    const prio = await db().selectFrom("ticket_priority").select("priority_id").executeTakeFirstOrThrow();
    for (const c of cards(await loadBoard(agent, params({ group: "assignee", prio: [prio.priority_id] }), "it")))
      expect(c.priority?.id).toBe(prio.priority_id);
  });

  it("chiusi: solo quelli recenti, con il conteggio degli esclusi", async () => {
    const agent = agents[0];
    const recent = await loadBoard(agent, params({ group: "dept" }), "it");
    const all = await loadBoard(agent, params({ group: "dept", older: true }), "it");
    expect(all.total).toBe(recent.total + recent.olderClosed);
    expect(all.olderClosed).toBe(0);
  });

  it("ricerca rapida: stessi criteri della lista (adhocQueue), intersecati con la sorgente", async () => {
    const agent = agents[0];
    const t = await db()
      .selectFrom("ticket as t")
      .innerJoin("ticket_status as st", "st.id", "t.status_id")
      .select(["t.number", "t.ticket_id"])
      .where("st.state", "=", "open")
      .orderBy("t.ticket_id")
      .executeTakeFirstOrThrow();
    for (const q of [t.number ?? "", "test", "@"]) {
      const criteria = quickSearchCriteria(q);
      if (!criteria) continue;
      const p = params({ group: "priority", q, older: true });
      const board = await loadBoard(agent, p, "it");
      if (board.error) continue;
      const ids = await allBoardIds(agent, p, board);
      const visible = new Set(await visibleIds(agent));
      const expected = (await listIds(agent, adhocQueue(agent, criteria, q))).filter((id) => visible.has(id));
      expect({ q, ids }).toEqual({ q, ids: expected });
      if (q === t.number) expect(ids).toContain(t.ticket_id);
    }
    expect((await loadBoard(agent, params({ q: "ab" }), "it")).error).toBe("tooShort");
    expect((await loadBoard(agent, params({ q: "uno due tre quattro" }), "it")).error).toBe("tooManyWords");
  });

  it("coda non navigabile: errore notFound", async () => {
    const board = await loadBoard(agents[0], params({ source: 999999 }), "it");
    expect(board.error).toBe("notFound");
  });

  it("raggruppamento per stato: colonne = ticketStatusChoices (mai 'deleted'), card nella colonna del proprio stato", async () => {
    const statuses = await ticketStatusChoices(db());
    expect(statuses.every((s) => s.state === "open" || s.state === "closed")).toBe(true);
    for (const agent of agents) {
      const board = await loadBoard(agent, params({ older: true }), "it");
      expect(board.dragEnabled).toBe(true);
      expect(board.columns.slice(0, statuses.length).map((c) => c.statusId)).toEqual(statuses.map((s) => s.id));
      for (const cell of Object.values(board.cells))
        for (const c of cell.cards) {
          const col = board.columns.find((x) => x.key === c.col)!;
          expect(col.key).toBe(String(c.statusId));
        }
    }
  });
});
