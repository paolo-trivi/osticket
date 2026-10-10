/** Dati serializzabili per il menu azioni del ticket (calcolati da TicketActionsMenu). */
export interface Choice {
  id: number;
  name: string;
}

/** Motivo per cui il ticket non è chiudibile (Ticket::isCloseable), mostrato nel modale di chiusura. */
export type CloseBlockerData = { reason: "fields" } | { reason: "tasks"; count: number } | { reason: "topic" } | null;

export interface TicketActionsData {
  ticketId: number;
  number: string;
  isAssigned: boolean;
  isAnswered: boolean;
  assignedStaff: (Choice & { isMe: boolean }) | null;
  assignedTeam: Choice | null;
  deptId: number;
  can: { assign: boolean; claim: boolean; transfer: boolean; release: boolean; mark: boolean; refer: boolean; status: boolean };
  /** agenti assegnabili (Dept::getAssignees) */
  agents: Choice[];
  /** team attivi */
  teams: Choice[];
  /** reparti di destinazione del trasferimento */
  depts: Choice[];
  referral: { agents: Choice[]; teams: Choice[]; depts: Choice[] };
  referrals: { id: number; type: "S" | "E" | "D"; name: string }[];
  /** stati open/closed abilitati nell'ordine della lista, attuale compreso (il menu lo esclude) */
  statuses: (Choice & { state: string })[];
  currentStatusId: number;
  /** avviso del modale di chiusura (null = chiudibile) */
  closeBlocker: CloseBlockerData;
  hasChildren: boolean;
}

export type ActionKind =
  | "claim"
  | "assignAgent"
  | "assignTeam"
  | "transfer"
  | "release"
  | "refer"
  | "markAnswered"
  | "markUnanswered"
  | { status: number };
