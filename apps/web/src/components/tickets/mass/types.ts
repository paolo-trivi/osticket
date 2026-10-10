import type { MassActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/actions-mass";
import type { AdhocListParams } from "@/server/domain/queue/queues";

/** Dati per le azioni di massa e l'export della lista ticket (calcolati da TicketMassBar). */
export interface MassData {
  can: {
    status: boolean;
    assign: boolean;
    merge: boolean;
    link: boolean;
    transfer: boolean;
    delete: boolean;
    export: boolean;
  };
  /** stati proposti dal menu (aperti, chiusi e, con permesso, eliminato) */
  statuses: { id: number; name: string; state: string }[];
  depts: { id: number; name: string }[];
  closedStatuses: { id: number; name: string }[];
  defaultChildStatusId: number;
  parentStatuses: { id: number; name: string }[];
  /** coda corrente (0 = ricerca ad hoc) */
  queueId: number;
  queueName: string;
  /** ricerca ad hoc da esportare (queueId 0) */
  adhoc?: AdhocListParams;
  sort?: string;
  dir?: string;
  exportFields: { path: string; label: string }[];
}

export type MassKind = "claim" | "assignAgents" | "assignTeams" | "transfer" | "delete" | "merge" | "link" | "export" | { status: number };

/** Proprietà comuni dei dialoghi di un'azione di massa sui ticket selezionati. */
export interface MassDialogProps {
  ids: number[];
  onClose: () => void;
  onSuccess: (s: MassActionState) => void;
}
