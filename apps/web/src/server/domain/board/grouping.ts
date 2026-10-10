/**
 * Regole pure della board: permessi di cambio stato per card, colonne ammesse al rilascio, ordinamento di
 * colonne/swimlane derivate dai dati e delle card. Nessun accesso al DB (testato in test/unit/board.test.ts).
 */
import type { Criterion } from "../queue/fields";
import type { BoardCard, BoardColumn, StatusState } from "./types";

/** Permesso di ruolo usato dal cambio stato (Ticket::PERM_CLOSE). */
const PERM_CLOSE = "ticket.close";

/** Il minimo dell'Agent che serve per calcolare i permessi (facile da simulare nei test). */
export interface AgentLike {
  id: number;
  isTeamMember(teamId: number): boolean;
  roleFor(
    deptId: number,
    assigned?: boolean,
  ): { perms: { has(perm: string): boolean } };
}

interface CardAccessInfo {
  deptId: number;
  staffId: number;
  teamId: number;
  state: StatusState;
}

/**
 * Permessi di cambio stato come il menu "Cambia stato" della vista ticket (TicketActionsMenu: canStatus =
 * roleOn(ticket, agent).perms.has(TicketPerm.CLOSE), status-options.tmpl.php di scp/), sia per chiudere sia per
 * riaprire. Il ruolo dipende dal reparto del ticket e, per i ticket aperti assegnati a me o a un mio team, dal
 * ruolo di assegnazione (roleOn/isAssignedTo di ticket.ts). Calcolato senza query, per evidenziare le colonne
 * ammesse durante il drag; il servizio changeTicketStatus resta l'autorità.
 */
export function cardPermissions(
  agent: AgentLike,
  t: CardAccessInfo,
): { canClose: boolean; canReopen: boolean } {
  const assigned =
    t.state === "open" &&
    (t.staffId === agent.id || agent.isTeamMember(t.teamId));
  const canClose = agent.roleFor(t.deptId, assigned).perms.has(PERM_CLOSE);
  return { canClose, canReopen: canClose };
}

export type DropBlock = "same" | "forbidden" | "lane" | null;

/**
 * Si può rilasciare la card su questa colonna di stato (e swimlane)? `null` = ammesso.
 * Il servizio di cambio stato resta l'autorità (task aperti, campi obbligatori…): qui solo i controlli
 * calcolabili senza query, per evidenziare le colonne durante il trascinamento.
 * Il lock di un altro agente non blocca: il cambio stato del PHP (ajax.tickets.php:setTicketStatus) non lo
 * controlla; la card mostra solo il lucchetto.
 */
export function dropBlock(
  card: Pick<BoardCard, "statusId" | "canClose" | "canReopen" | "lane">,
  target: Pick<BoardColumn, "statusId" | "state">,
  targetLane: string,
): DropBlock {
  if (target.statusId === undefined || !target.state) return "forbidden";
  if (target.statusId === card.statusId) return "same";
  if (targetLane !== card.lane) return "lane";
  if (target.state === "closed" ? !card.canClose : !card.canReopen)
    return "forbidden";
  return null;
}

/** La card può essere spostata in almeno una delle colonne? */
export function canMoveAnywhere(
  card: BoardCard,
  columns: BoardColumn[],
): boolean {
  return columns.some((c) => dropBlock(card, c, card.lane) === null);
}

/** Ordine delle card: priorità (urgenza crescente, senza priorità in fondo), poi aggiornamento più recente, poi id. */
export function compareCards(
  a: { priority: { urgency: number } | null; updatedMs: number; id: number },
  b: { priority: { urgency: number } | null; updatedMs: number; id: number },
): number {
  const ua = a.priority?.urgency ?? 99;
  const ub = b.priority?.urgency ?? 99;
  if (ua !== ub) return ua - ub;
  if (a.updatedMs !== b.updatedMs) return b.updatedMs - a.updatedMs;
  return b.id - a.id;
}

const collator = new Intl.Collator("it", {
  sensitivity: "base",
  numeric: true,
});

/**
 * Ordine delle colonne/swimlane derivate dai dati:
 * - assegnatario: io, poi gli agenti, poi i team (alfabetico), "Non assegnato" per primo come colonna e per
 *   ultimo come swimlane (come Jira);
 * - priorità: per urgenza, "Senza priorità" in fondo;
 * - reparto: alfabetico, "Senza reparto" in fondo.
 */
export function orderDerived<
  T extends Pick<
    BoardColumn,
    "key" | "title" | "isMe" | "assigneeKind" | "special"
  > & { urgency?: number },
>(
  kind: "priority" | "assignee" | "dept",
  items: T[],
  role: "column" | "lane",
): T[] {
  const rank = (x: T): number => {
    if (kind === "assignee") {
      if (x.special === "unassigned") return role === "column" ? 0 : 4;
      if (x.isMe) return 1;
      return x.assigneeKind === "team" ? 3 : 2;
    }
    return x.special ? 9 : 1;
  };
  return [...items].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    if (
      kind === "priority" &&
      a.urgency !== undefined &&
      b.urgency !== undefined &&
      a.urgency !== b.urgency
    )
      return a.urgency - b.urgency;
    return collator.compare(a.title, b.title) || a.key.localeCompare(b.key);
  });
}

/** Iniziali per l'avatar: prima lettera delle prime due parole. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s =
    parts.length > 1
      ? (parts[0][0] ?? "") + (parts[parts.length - 1][0] ?? "")
      : (parts[0] ?? "").slice(0, 2);
  return s.toUpperCase();
}

/** Scadenza vicina: entro `hours` ore da adesso e non ancora passata. */
export function isDueSoon(
  dueMs: number | null,
  nowMs: number,
  hours = 24,
): boolean {
  if (dueMs === null) return false;
  return dueMs >= nowMs && dueMs - nowMs <= hours * 3600_000;
}

/**
 * Stati (open/closed/…) a cui i criteri di una coda limitano i ticket, se la coda ha un criterio
 * `status__state includes {…}`; null = nessun limite noto.
 */
export function criteriaStates(criteria: Criterion[]): Set<string> | null {
  let out: Set<string> | null = null;
  for (const [path, method, value] of criteria) {
    if (path !== "status__state" || !value || typeof value !== "object")
      continue;
    const keys = Object.keys(value as Record<string, unknown>);
    if (method === "includes")
      out = new Set(keys.filter((k) => !out || out.has(k)));
    else if (method === "!includes") {
      const all: Set<string> =
        out ?? new Set(["open", "closed", "archived", "deleted"]);
      out = new Set([...all].filter((s) => !keys.includes(s)));
    }
  }
  return out;
}

/** Colore di priorità del DB utilizzabile in uno style inline (#rgb/#rrggbb): fonte unica in lib/color. */
export { safeColor } from "@/lib/color";
