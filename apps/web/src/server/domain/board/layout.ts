import "server-only";

import type { TicketRow } from "../ticket/rows";
import { type BoardContext, type Placed, staffName } from "./cards";
import { initials, orderDerived, safeColor } from "./grouping";
import type { BoardGroupBy, BoardLaneBy } from "./params";
import { cellKey, type BoardCard, type BoardCell, type BoardColumn, type BoardLane } from "./types";

/**
 * Raggruppamento della board (senza query): colonne, celle e swimlane a partire dai ticket piazzati e dalle loro
 * card. Le intestazioni derivate (priorità, assegnatario, reparto) vengono dalla prima card di ogni gruppo.
 */

type StatusChoice = { id: number; name: string; state: string | null };
type PriorityRow = { priority_id: number; priority_desc: string; priority_color: string | null };

/** Colonna/swimlane derivata da una card (raggruppamenti per priorità, assegnatario, reparto). */
function derivedHeader(
  by: "priority" | "assignee" | "dept",
  key: string,
  r: TicketRow | undefined,
  ctx: BoardContext,
): BoardColumn & { urgency?: number } {
  switch (by) {
    case "priority":
      if (key === "0" || !r) return { key, title: "", special: "noPriority", urgency: 99 };
      return {
        key,
        title: r.priority ?? key,
        color: safeColor(r.priority_color),
        urgency: Number(r.priority_urgency ?? 99),
      };
    case "dept":
      return r?.dept_name ? { key, title: r.dept_name } : { key, title: "", special: "noDept" };
    case "assignee": {
      if (key === "u" || !r) return { key, title: "", special: "unassigned" };
      if (key.startsWith("s")) {
        return {
          key,
          title: staffName(r, ctx),
          assigneeKind: "staff",
          initials: initials(`${r.staff_first ?? ""} ${r.staff_last ?? ""}`),
          isMe: Number(key.slice(1)) === ctx.agent.id,
        };
      }
      const title = r.team_name ?? "";
      return { key, title, assigneeKind: "team", initials: initials(title) };
    }
  }
}

/** Prima card (id del ticket) di ogni colonna e di ogni swimlane, per le intestazioni derivate. */
export function firstTickets(places: Placed[]): { firstCol: Map<string, number>; firstLane: Map<string, number> } {
  const firstCol = new Map<string, number>();
  const firstLane = new Map<string, number>();
  for (const p of places) {
    if (!firstCol.has(p.grp)) firstCol.set(p.grp, p.ticket_id);
    if (!firstLane.has(p.lane_key)) firstLane.set(p.lane_key, p.ticket_id);
  }
  return { firstCol, firstLane };
}

/** Colonne: stati del menu "Cambia stato", priorità per urgenza, oppure gruppi derivati dalle card. */
export function buildColumns(
  group: BoardGroupBy,
  input: {
    statuses: StatusChoice[];
    priorities: PriorityRow[];
    firstCol: Map<string, number>;
    cards: Map<number, BoardCard>;
    rowOf: Map<number, TicketRow>;
    ctx: BoardContext;
  },
): BoardColumn[] {
  const { statuses, priorities, firstCol, cards, rowOf, ctx } = input;
  const columns: BoardColumn[] = [];
  if (group === "status") {
    const seen = new Set<string>();
    for (const s of statuses) {
      columns.push({ key: String(s.id), title: s.name, statusId: s.id, state: s.state === "closed" ? "closed" : "open" });
      seen.add(String(s.id));
    }
    // Ticket in uno stato non proposto dal menu (es. stato disattivato): colonna in coda, non come destinazione
    for (const [key, id] of firstCol) {
      if (seen.has(key)) continue;
      const c = cards.get(id);
      columns.push({ key, title: c?.status ?? key });
    }
  } else if (group === "priority") {
    for (const p of priorities) {
      columns.push({ key: String(p.priority_id), title: p.priority_desc, color: safeColor(p.priority_color) });
    }
    if (firstCol.has("0")) columns.push({ key: "0", title: "", special: "noPriority" });
  } else {
    columns.push(
      ...orderDerived(
        group,
        [...firstCol].map(([key, id]) => derivedHeader(group, key, rowOf.get(id), ctx)),
        "column",
      ),
    );
  }
  return columns;
}

/** Celle (con i totali della query) e totali per swimlane; poi i chiusi meno recenti esclusi per cella. */
export function buildCells(
  places: Placed[],
  cards: Map<number, BoardCard>,
  older: Array<{ grp: string; lane_key: string; n: number }>,
): { cells: Record<string, BoardCell>; laneTotals: Map<string, number>; olderClosed: number } {
  const laneTotals = new Map<string, number>();
  const cells: Record<string, BoardCell> = {};
  for (const p of places) {
    const card = cards.get(p.ticket_id);
    if (!card) continue;
    const key = cellKey(p.lane_key, p.grp);
    let cell = cells[key];
    if (!cell) {
      cell = cells[key] = { cards: [], total: p.cnt, olderClosed: 0 };
      laneTotals.set(p.lane_key, (laneTotals.get(p.lane_key) ?? 0) + cell.total);
    }
    cell.cards.push(card);
  }
  let olderClosed = 0;
  for (const o of older) {
    const key = cellKey(String(o.lane_key), String(o.grp));
    const n = Number(o.n);
    olderClosed += n;
    (cells[key] ??= { cards: [], total: 0, olderClosed: 0 }).olderClosed = n;
  }
  return { cells, laneTotals, olderClosed };
}

/** Swimlane: una sola ("all") senza raggruppamento per righe, altrimenti derivate dalle card. */
export function buildLanes(
  lane: BoardLaneBy,
  input: { firstLane: Map<string, number>; laneTotals: Map<string, number>; rowOf: Map<number, TicketRow>; ctx: BoardContext },
): BoardLane[] {
  const { firstLane, laneTotals, rowOf, ctx } = input;
  if (lane === "none") {
    return [{ key: "all", title: "", special: "all", total: [...laneTotals.values()].reduce((a, b) => a + b, 0) }];
  }
  return orderDerived(
    lane,
    [...firstLane].map(([key, id]) => derivedHeader(lane, key, rowOf.get(id), ctx)),
    "lane",
  ).map((h) => ({ ...h, total: laneTotals.get(h.key) ?? 0 }));
}
