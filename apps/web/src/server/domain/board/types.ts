/**
 * Dati della board Kanban passati ai componenti client (serializzabili). Modulo puro.
 */
import type { BoardGroupBy, BoardLaneBy } from "./params";

export type StatusState = "open" | "closed";

export interface BoardPriority {
  id: number;
  name: string;
  /** ticket_priority.priority_color (validato #rrggbb) */
  color: string | null;
  /** 1 = più urgente */
  urgency: number;
}

export interface BoardAssignee {
  kind: "staff" | "team";
  id: number;
  name: string;
  initials: string;
}

export interface BoardCard {
  id: number;
  number: string;
  subject: string;
  user: string;
  priority: BoardPriority | null;
  assignee: BoardAssignee | null;
  dept: string;
  topic: string;
  statusId: number;
  /** nome dello stato */
  status: string;
  state: StatusState;
  overdue: boolean;
  /** scadenza entro 24 ore (non ancora scaduto) */
  dueSoon: boolean;
  /** scadenza (duedate, altrimenti est_duedate) formattata nel fuso dell'agente */
  dueLabel: string | null;
  /** ultimo aggiornamento, relativo ("3 ore fa") e completo */
  updatedLabel: string;
  updatedTitle: string;
  /** ultimo aggiornamento (epoch ms) per l'ordinamento lato client */
  updatedMs: number;
  /** voci del thread visibili (come il contatore della lista ticket) */
  threadCount: number;
  attachments: number;
  /** nome dell'agente che ha il lock attivo, se diverso da me */
  lockedBy: string | null;
  /** permessi per il cambio stato (ruolo dell'agente sul reparto del ticket) */
  canClose: boolean;
  canReopen: boolean;
  /** chiavi di colonna e swimlane */
  col: string;
  lane: string;
}

export type SpecialKey = "unassigned" | "noPriority" | "noDept" | "all";

export interface BoardColumn {
  key: string;
  title: string;
  /** titolo da tradurre (colonne/swimlane "Non assegnato", "Senza priorità"…) */
  special?: SpecialKey;
  /** per le colonne di stato */
  statusId?: number;
  state?: StatusState;
  /** colore (priorità) */
  color?: string | null;
  /** iniziali (assegnatario) */
  initials?: string;
  /** assegnatario: agente o team */
  assigneeKind?: "staff" | "team";
  /** l'assegnatario sono io */
  isMe?: boolean;
}

export type BoardLane = BoardColumn & { total: number };

export interface BoardCell {
  cards: BoardCard[];
  total: number;
  /** ticket chiusi più vecchi di RECENT_CLOSED_DAYS esclusi dalla cella */
  olderClosed: number;
}

export interface BoardSourceOption {
  value: string;
  title: string;
  depth: number;
  count: number | "-" | null;
}

/** notFound: coda non navigabile; tooShort/tooManyWords: ricerca rapida non valida (come la lista ticket) */
export type BoardError = "notFound" | "tooShort" | "tooManyWords" | "noStatuses";

export interface BoardData {
  group: BoardGroupBy;
  lane: BoardLaneBy;
  columns: BoardColumn[];
  lanes: BoardLane[];
  /** chiave `${lane}::${col}` */
  cells: Record<string, BoardCell>;
  total: number;
  /** ticket chiusi da più di RECENT_CLOSED_DAYS giorni esclusi */
  olderClosed: number;
  perCell: number;
  /** titolo della sorgente (coda) */
  sourceTitle: string;
  /** la coda sorgente contiene ticket chiusi? (false = colonne chiuse sempre vuote) */
  sourceHasClosed: boolean;
  /** drag & drop attivo (solo raggruppamento per stato) */
  dragEnabled: boolean;
  error?: BoardError;
}

/** Errori del cambio stato dalla board (testi in board.errors; mai il dettaglio inglese del servizio). */
export type MoveErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_status"
  | "same_status"
  | "not_closeable"
  | "open_tasks"
  | "missing_fields"
  | "topic_required"
  | "internal"
  | "session"
  | "invalid";

export function cellKey(lane: string, col: string): string {
  return `${lane}::${col}`;
}

export interface PreviewEntry {
  id: number;
  type: "M" | "R" | "N";
  poster: string;
  when: string;
  whenTitle: string;
  excerpt: string;
}

export interface BoardPreview {
  id: number;
  number: string;
  entries: PreviewEntry[];
}
