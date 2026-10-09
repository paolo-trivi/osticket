/** Dati serializzabili per il menu azioni del ticket (calcolati da TicketActionsMenu). */
export interface Choice {
  id: number;
  name: string;
}

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
  /** stati proposti dal menu (diversi dall'attuale) */
  statuses: (Choice & { state: string })[];
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
