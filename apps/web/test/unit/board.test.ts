import { describe, expect, it } from "vitest";

import { initials } from "@/lib/format/initials";

import {
  appendCards,
  applyMove,
  cellOf,
  mergeCells,
  movedCard,
} from "@/components/board/cells";
import {
  canMoveAnywhere,
  cardPermissions,
  compareCards,
  criteriaStates,
  dropBlock,
  isDueSoon,
  orderDerived,
  safeColor,
  type AgentLike,
} from "@/server/domain/board/grouping";
import {
  boardHref,
  boardSearchParams,
  DEFAULT_BOARD_PARAMS,
  hasActiveFilters,
  parseBoardParams,
} from "@/server/domain/board/params";
import { plainExcerpt } from "@/server/domain/board/preview";
import type { BoardCard, BoardColumn } from "@/server/domain/board/types";

function card(p: Partial<BoardCard> & { id: number }): BoardCard {
  return {
    number: String(1000 + p.id),
    subject: "s",
    user: "u",
    priority: null,
    assignee: null,
    dept: "",
    topic: "",
    statusId: 1,
    status: "Open",
    state: "open",
    overdue: false,
    dueSoon: false,
    dueLabel: null,
    updatedLabel: "",
    updatedTitle: "",
    updatedMs: 0,
    threadCount: 0,
    attachments: 0,
    lockedBy: null,
    canClose: true,
    canReopen: true,
    col: "1",
    lane: "all",
    ...p,
  };
}

const OPEN: BoardColumn = {
  key: "1",
  title: "Open",
  statusId: 1,
  state: "open",
};
const RESOLVED: BoardColumn = {
  key: "2",
  title: "Resolved",
  statusId: 2,
  state: "closed",
};
const CLOSED: BoardColumn = {
  key: "3",
  title: "Closed",
  statusId: 3,
  state: "closed",
};

describe("board: parametri nell'URL", () => {
  it("default e valori non validi", () => {
    expect(parseBoardParams({})).toEqual(DEFAULT_BOARD_PARAMS);
    const p = parseBoardParams({
      src: "abc",
      group: "x",
      lane: "y",
      prio: "3,a,0,3,1",
      mine: "1",
      unassigned: "1",
    });
    expect(p.source).toBe("all");
    expect(p.group).toBe("status");
    expect(p.lane).toBe("none");
    expect(p.prio).toEqual([1, 3]);
    // "Solo miei" e "Non assegnati" si escludono
    expect(p.mine).toBe(true);
    expect(p.unassigned).toBe(false);
  });

  it("swimlane uguale al raggruppamento → nessuna", () => {
    expect(parseBoardParams({ group: "priority", lane: "priority" }).lane).toBe(
      "none",
    );
  });

  it("andata e ritorno URL ↔ parametri, solo i valori non di default", () => {
    const p = parseBoardParams({
      src: "5",
      group: "assignee",
      lane: "dept",
      overdue: "1",
      prio: "4,2",
      q: " vpn ",
      older: "1",
    });
    expect(p.q).toBe("vpn");
    const qs = boardSearchParams(p).toString();
    expect(qs).toBe(
      "src=5&group=assignee&lane=dept&overdue=1&prio=2%2C4&q=vpn&older=1",
    );
    expect(parseBoardParams(new URLSearchParams(qs))).toEqual(p);
    expect(boardHref(DEFAULT_BOARD_PARAMS)).toBe("/agent/board");
    expect(hasActiveFilters(p)).toBe(true);
    expect(hasActiveFilters({ ...p, overdue: false, prio: [], q: "" })).toBe(
      false,
    );
  });
});

describe("board: permessi e colonne ammesse", () => {
  const agent = (
    perms: Record<number, string[]>,
    assignedPerms: string[] = [],
  ): AgentLike => ({
    id: 7,
    isTeamMember: (t) => t === 3,
    roleFor: (dept, assigned) => ({
      perms: {
        has: (p: string) =>
          (
            perms[dept] ?? (assigned ? assignedPerms : ["ticket.create"])
          ).includes(p),
      },
    }),
  });

  it("serve ticket.close nel ruolo del reparto (anche per riaprire)", () => {
    const a = agent({
      1: ["ticket.close"],
      2: ["ticket.edit", "ticket.create"],
    });
    expect(
      cardPermissions(a, { deptId: 1, staffId: 0, teamId: 0, state: "open" }),
    ).toEqual({ canClose: true, canReopen: true });
    expect(
      cardPermissions(a, { deptId: 2, staffId: 0, teamId: 0, state: "closed" }),
    ).toEqual({ canClose: false, canReopen: false });
  });

  it("ticket aperto assegnato a me o a un mio team: ruolo di assegnazione fuori dai miei reparti", () => {
    const a = agent({}, ["ticket.close"]);
    expect(
      cardPermissions(a, { deptId: 9, staffId: 7, teamId: 0, state: "open" })
        .canClose,
    ).toBe(true);
    expect(
      cardPermissions(a, { deptId: 9, staffId: 0, teamId: 3, state: "open" })
        .canClose,
    ).toBe(true);
    // chiuso: non conta più come assegnato
    expect(
      cardPermissions(a, { deptId: 9, staffId: 7, teamId: 0, state: "closed" })
        .canClose,
    ).toBe(false);
  });

  it("dropBlock: stesso stato, swimlane, lock, permessi", () => {
    const c = card({ id: 1 });
    expect(dropBlock(c, OPEN, "all")).toBe("same");
    expect(dropBlock(c, RESOLVED, "all")).toBeNull();
    expect(dropBlock(c, RESOLVED, "s5")).toBe("lane");
    // il lock di un altro agente non blocca lo spostamento (come il PHP): solo il lucchetto sulla card
    expect(dropBlock(card({ id: 9, lockedBy: "Laura" }), RESOLVED, "all")).toBeNull();
    expect(dropBlock({ ...c, canClose: false }, RESOLVED, "all")).toBe(
      "forbidden",
    );
    const closed = card({
      id: 2,
      statusId: 2,
      state: "closed",
      col: "2",
      canClose: false,
      canReopen: false,
    });
    expect(dropBlock(closed, OPEN, "all")).toBe("forbidden");
    expect(dropBlock(closed, CLOSED, "all")).toBe("forbidden");
    expect(dropBlock(c, {}, "all")).toBe("forbidden");
    expect(canMoveAnywhere(c, [OPEN, RESOLVED])).toBe(true);
    expect(
      canMoveAnywhere({ ...c, canClose: false, canReopen: false }, [
        OPEN,
        RESOLVED,
        CLOSED,
      ]),
    ).toBe(false);
  });
});

describe("board: ordinamenti", () => {
  it("card: urgenza, poi aggiornamento più recente, poi id", () => {
    const list = [
      { id: 1, priority: null, updatedMs: 50 },
      { id: 2, priority: { urgency: 3 }, updatedMs: 10 },
      { id: 3, priority: { urgency: 1 }, updatedMs: 5 },
      { id: 4, priority: { urgency: 3 }, updatedMs: 20 },
      { id: 5, priority: { urgency: 3 }, updatedMs: 20 },
    ];
    expect([...list].sort(compareCards).map((c) => c.id)).toEqual([
      3, 5, 4, 2, 1,
    ]);
  });

  it("assegnatari: io, agenti, team; Non assegnato prima come colonna e ultimo come swimlane", () => {
    const items = [
      { key: "t1", title: "Rete", assigneeKind: "team" as const },
      { key: "u", title: "", special: "unassigned" as const },
      { key: "s2", title: "Zeno", assigneeKind: "staff" as const },
      { key: "s9", title: "Marco", assigneeKind: "staff" as const, isMe: true },
      { key: "s3", title: "anna", assigneeKind: "staff" as const },
    ];
    expect(orderDerived("assignee", items, "column").map((x) => x.key)).toEqual(
      ["u", "s9", "s3", "s2", "t1"],
    );
    expect(orderDerived("assignee", items, "lane").map((x) => x.key)).toEqual([
      "s9",
      "s3",
      "s2",
      "t1",
      "u",
    ]);
  });

  it("priorità per urgenza, 'senza priorità' in fondo; reparti alfabetici", () => {
    const pr = [
      { key: "1", title: "Low", urgency: 4 },
      { key: "0", title: "", special: "noPriority" as const, urgency: 99 },
      { key: "4", title: "Emergency", urgency: 1 },
    ];
    expect(orderDerived("priority", pr, "lane").map((x) => x.key)).toEqual([
      "4",
      "1",
      "0",
    ]);
    const depts = [
      { key: "2", title: "Ufficio Tecnico" },
      { key: "1", title: "Servizi Informatici / Reti" },
      { key: "3", title: "Servizi Informatici" },
    ];
    expect(orderDerived("dept", depts, "column").map((x) => x.key)).toEqual([
      "3",
      "1",
      "2",
    ]);
  });
});

describe("board: utilità", () => {
  it("stati ammessi dai criteri della coda", () => {
    expect(
      criteriaStates([["status__state", "includes", { open: "Open" }]]),
    ).toEqual(new Set(["open"]));
    expect(criteriaStates([["isanswered", "nset", null]])).toBeNull();
    expect(
      criteriaStates([["status__state", "!includes", { closed: "Closed" }]]),
    ).toEqual(new Set(["open", "archived", "deleted"]));
  });

  it("scadenza vicina, iniziali, colori", () => {
    expect(isDueSoon(null, 0)).toBe(false);
    expect(isDueSoon(10 * 3600_000, 0)).toBe(true);
    expect(isDueSoon(30 * 3600_000, 0)).toBe(false);
    expect(isDueSoon(-1, 0)).toBe(false);
    expect(initials("Marco  Rossi")).toBe("MR");
    expect(initials("Supporto")).toBe("SU");
    expect(initials("Anna Maria Bianchi")).toBe("AB");
    expect(safeColor("#FEE7E7")).toBe("#FEE7E7");
    expect(safeColor("red;background:url(x)")).toBeNull();
  });

  it("estratto di testo dai corpi HTML del thread", () => {
    expect(
      plainExcerpt(
        "<p>Ciao&nbsp;<b>mondo</b></p><style>p{}</style><p>riga 2</p>",
        "html",
      ),
    ).toBe("Ciao mondo\nriga 2");
    expect(plainExcerpt("x".repeat(400), "text", 10)).toBe("xxxxxxxxx…");
  });
});

describe("board: stato client delle celle", () => {
  const a = card({
    id: 1,
    priority: { id: 2, name: "N", color: null, urgency: 3 },
    updatedMs: 10,
  });
  const b = card({
    id: 2,
    priority: { id: 4, name: "E", color: null, urgency: 1 },
    updatedMs: 5,
  });
  const c = card({
    id: 3,
    statusId: 2,
    state: "closed",
    col: "2",
    priority: { id: 2, name: "N", color: null, urgency: 3 },
    updatedMs: 20,
  });
  const base = {
    "all::1": { cards: [b, a], total: 2, olderClosed: 0 },
    "all::2": { cards: [c], total: 5, olderClosed: 3 },
  };

  it("spostamento ottimistico nella posizione ordinata e rollback", () => {
    const moved = movedCard(a, "2", 2, "closed", "Resolved");
    expect(cellOf(moved)).toBe("all::2");
    const after = applyMove(base, "all::1", "all::2", moved);
    expect(after["all::1"]).toEqual({ cards: [b], total: 1, olderClosed: 0 });
    expect(after["all::2"].cards.map((x) => x.id)).toEqual([3, 1]);
    expect(after["all::2"].total).toBe(6);
    expect(after["all::2"].olderClosed).toBe(3);
    const back = applyMove(after, "all::2", "all::1", a);
    expect(back["all::1"].cards.map((x) => x.id)).toEqual([2, 1]);
    expect(back["all::1"].total).toBe(2);
    expect(back["all::2"].total).toBe(5);
  });

  it("dati nuovi dal server: prevalgono, le card caricate in più restano", () => {
    const extra = card({ id: 9, statusId: 2, state: "closed", col: "2" });
    const client = appendCards(base, "all::2", [extra, c], 5);
    expect(client["all::2"].cards.map((x) => x.id)).toEqual([3, 9]);
    const server = {
      "all::1": { cards: [b], total: 1, olderClosed: 0 },
      "all::2": {
        cards: [{ ...a, col: "2", statusId: 2, state: "closed" as const }, c],
        total: 6,
        olderClosed: 3,
      },
    };
    const merged = mergeCells(server, client);
    expect(merged["all::2"].cards.map((x) => x.id)).toEqual([1, 3, 9]);
    expect(merged["all::2"].total).toBe(6);
    // la card 1 non resta duplicata nella vecchia cella
    expect(merged["all::1"].cards.map((x) => x.id)).toEqual([2]);
  });
});
