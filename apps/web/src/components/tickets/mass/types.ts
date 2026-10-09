/** Dati per le azioni di massa e l'export della lista ticket (calcolati da TicketMassBar). */
export interface MassData {
  can: { status: boolean; assign: boolean; merge: boolean; link: boolean; transfer: boolean; delete: boolean; export: boolean };
  /** stati proposti dal menu (aperti, chiusi e, con permesso, eliminato) */
  statuses: { id: number; name: string; state: string }[];
  depts: { id: number; name: string }[];
  closedStatuses: { id: number; name: string }[];
  defaultChildStatusId: number;
  parentStatuses: { id: number; name: string }[];
  /** coda corrente (0 = ricerca, non esportabile) */
  queueId: number;
  queueName: string;
  sort?: string;
  dir?: string;
  exportFields: { path: string; label: string }[];
}

export type MassKind = "claim" | "assignAgents" | "assignTeams" | "transfer" | "delete" | "merge" | "link" | "export" | { status: number };
