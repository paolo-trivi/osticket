import "server-only";

import { CustomQueue } from "@/lib/osticket/flags";
import { ObjectType } from "@/lib/osticket/object-types";

import { db, type DbOrTx } from "../../db";
import { phpJsonDecode } from "../../format/php-json";
import type { Agent } from "../staff/staff";
import type { Criterion } from "./fields";

/**
 * Code dei ticket (CustomQueue/SavedQueue di include/class.queue.php e class.search.php): modello con
 * l'ereditarietà di criteri/colonne/ordinamenti, caricamento, ricerche temporanee e rapide, code
 * navigabili dall'agente.
 */

interface QueueRow {
  id: number;
  parent_id: number;
  columns_id: number | null;
  sort_id: number | null;
  flags: number;
  staff_id: number;
  sort: number;
  title: string;
  config: string | null;
  filter: string | null;
}

export class TicketQueue {
  constructor(
    readonly row: QueueRow,
    readonly parent: TicketQueue | null,
    private readonly all: Map<number, TicketQueue>,
  ) {}

  get id() {
    return this.row.id;
  }
  get title() {
    return this.row.title;
  }
  has(flag: number) {
    return (this.row.flags & flag) !== 0;
  }
  get isAQueue() {
    return this.has(CustomQueue.QUEUE);
  }
  get isASubQueue(): boolean {
    return this.parent ? this.parent.isASubQueue : this.isAQueue;
  }
  get children(): TicketQueue[] {
    return [...this.all.values()].filter((q) => q.row.parent_id === this.id).sort((a, b) => a.row.sort - b.row.sort);
  }

  /** CustomQueue::getCriteria (formato vecchio [..] o nuovo {criteria:[..]}) */
  ownCriteria(): Criterion[] {
    const parsed = phpJsonDecode<unknown>(this.row.config, []);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return ((parsed as { criteria?: Criterion[] }).criteria ?? []) as Criterion[];
    }
    return Array.isArray(parsed) ? (parsed as Criterion[]) : [];
  }

  /** Criteri effettivi come getBasicQuery(): quelli del padre se la coda li eredita, poi i propri. */
  effectiveCriteria(): Criterion[] {
    const inherited =
      this.parent && this.has(CustomQueue.INHERIT_CRITERIA) && this.row.parent_id ? this.parent.effectiveCriteria() : [];
    return [...inherited, ...this.ownCriteria()];
  }

  /** Coda da cui prendere le colonne (columns_id, ereditarietà, oppure la coda stessa). */
  columnsSource(): TicketQueue {
    if (this.row.columns_id && this.all.get(this.row.columns_id)) return this.all.get(this.row.columns_id)!.columnsSource();
    if (this.row.parent_id && this.has(CustomQueue.INHERIT_COLUMNS) && this.parent) return this.parent.columnsSource();
    return this;
  }

  sortSource(): TicketQueue {
    return this.has(CustomQueue.INHERIT_SORTING) && this.parent ? this.parent.sortSource() : this;
  }

  defaultSortId(): number | null {
    if (this.has(CustomQueue.INHERIT_DEF_SORT) && this.parent) {
      const id = this.parent.defaultSortId();
      if (id) return id;
    }
    return this.row.sort_id;
  }
}

export async function loadQueues(executor: DbOrTx = db()): Promise<Map<number, TicketQueue>> {
  const rows = await executor
    .selectFrom("queue")
    .select(["id", "parent_id", "columns_id", "sort_id", "flags", "staff_id", "sort", "title", "config", "filter"])
    .where((eb) => eb.or([eb("root", "=", ObjectType.TICKET), eb("root", "is", null)]))
    .orderBy("sort")
    .execute();
  const all = new Map<number, TicketQueue>();
  const byId = new Map(rows.map((r) => [r.id, { ...r, title: r.title ?? "" } as QueueRow]));
  const build = (id: number): TicketQueue | null => {
    if (all.has(id)) return all.get(id)!;
    const row = byId.get(id);
    if (!row) return null;
    const parent = row.parent_id ? build(row.parent_id) : null;
    const q = new TicketQueue(row, parent, all);
    all.set(id, q);
    return q;
  };
  for (const r of rows) build(r.id);
  return all;
}

/** Ricerca temporanea (AdhocSearch): non è una coda, appartiene all'agente. */
export function adhocQueue(agent: Agent, criteria: Criterion[], title: string): TicketQueue {
  const row: QueueRow = {
    id: 0,
    parent_id: 0,
    columns_id: null,
    sort_id: null,
    flags: 0,
    staff_id: agent.id,
    sort: 0,
    title,
    config: JSON.stringify({ criteria, conditions: [] }),
    filter: null,
  };
  return new TicketQueue(row, null, new Map());
}

/**
 * Ricerca rapida di scp/tickets.php (a=search): email → user__emails__address, numero → number,
 * altrimenti full-text. Massimo 3 parole.
 */
export function quickSearchCriteria(query: string): Criterion[] | null {
  const q = query.trim();
  if (!q || q.split(/\s+/u).length >= 4) return null;
  if (/(.*@.{2,})|(.{2,}@.*)/.test(q)) {
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q);
    return [["user__emails__address", valid ? "equal" : "contains", q]];
  }
  if (/^\d+(\.\d+)?$/.test(q)) return [["number", "contains", q]];
  return [[":keywords", null, q]];
}

/** Code visibili nella navigazione dell'agente: di sistema o personali, non disattivate. */
export function navigableQueues(all: Map<number, TicketQueue>, agent: Agent): TicketQueue[] {
  return [...all.values()].filter(
    (q) => !q.has(CustomQueue.DISABLED) && (q.row.staff_id === 0 || q.row.staff_id === agent.id) && (q.isAQueue || q.row.staff_id === agent.id),
  );
}
