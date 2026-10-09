/**
 * Operazioni pure sullo stato client delle celle della board (spostamento ottimistico, rollback, fusione con i
 * dati aggiornati dal server). Testate in test/unit/board.test.ts.
 */
import { compareCards } from "@/server/domain/board/grouping";
import {
  cellKey,
  type BoardCard,
  type BoardCell,
} from "@/server/domain/board/types";

export type Cells = Record<string, BoardCell>;

/** Inserisce la card nella posizione data dall'ordinamento della board. */
function insertSorted(cards: BoardCard[], card: BoardCard): BoardCard[] {
  const out = cards.filter((c) => c.id !== card.id);
  const i = out.findIndex((c) => compareCards(card, c) < 0);
  if (i < 0) out.push(card);
  else out.splice(i, 0, card);
  return out;
}

/**
 * Sposta la card `moved` (già aggiornata: col/stato) dalla cella `from` alla cella `to`, aggiornando i totali.
 * Restituisce un nuovo oggetto; le celle non coinvolte restano le stesse istanze.
 */
export function applyMove(
  cells: Cells,
  from: string,
  to: string,
  moved: BoardCard,
): Cells {
  if (from === to) return cells;
  const src = cells[from] ?? { cards: [], total: 0, olderClosed: 0 };
  const dst = cells[to] ?? { cards: [], total: 0, olderClosed: 0 };
  const had = src.cards.some((c) => c.id === moved.id);
  return {
    ...cells,
    [from]: {
      ...src,
      cards: src.cards.filter((c) => c.id !== moved.id),
      total: Math.max(0, src.total - (had ? 1 : 0)),
    },
    [to]: {
      ...dst,
      cards: insertSorted(dst.cards, moved),
      total: dst.total + 1,
    },
  };
}

/** Card spostata in un'altra colonna di stato. */
export function movedCard(
  card: BoardCard,
  col: string,
  statusId: number,
  state: BoardCard["state"],
  status: string,
): BoardCard {
  return {
    ...card,
    col,
    statusId,
    status,
    state,
    overdue: state === "open" ? card.overdue : false,
    dueSoon: state === "open" ? card.dueSoon : false,
  };
}

/** Cella della card nello stato corrente. */
export function cellOf(card: Pick<BoardCard, "lane" | "col">): string {
  return cellKey(card.lane, card.col);
}

/**
 * Nuovi dati dal server (dopo un cambio stato o un aggiornamento): le card del server prevalgono; le card caricate
 * in più dal client ("carica altri", o spostate oltre la prima pagina) che il server non ha restituito restano in
 * coda alla loro cella. Totali e conteggi dei chiusi esclusi vengono dal server.
 */
export function mergeCells(server: Cells, client: Cells): Cells {
  const serverIds = new Set<number>();
  for (const cell of Object.values(server))
    for (const c of cell.cards) serverIds.add(c.id);
  const out: Cells = {};
  for (const [key, cell] of Object.entries(server))
    out[key] = { ...cell, cards: [...cell.cards] };
  for (const [key, cell] of Object.entries(client)) {
    const extra = cell.cards.filter((c) => !serverIds.has(c.id));
    if (!extra.length) continue;
    const target = (out[key] ??= { cards: [], total: 0, olderClosed: 0 });
    target.cards.push(...extra);
    target.total = Math.max(target.total, target.cards.length);
  }
  return out;
}

/** Aggiunge le card di "carica altri" senza duplicati. */
export function appendCards(
  cells: Cells,
  key: string,
  cards: BoardCard[],
  total: number,
): Cells {
  const cell = cells[key] ?? { cards: [], total: 0, olderClosed: 0 };
  const seen = new Set(cell.cards.map((c) => c.id));
  return {
    ...cells,
    [key]: {
      ...cell,
      cards: [...cell.cards, ...cards.filter((c) => !seen.has(c.id))],
      total,
    },
  };
}
