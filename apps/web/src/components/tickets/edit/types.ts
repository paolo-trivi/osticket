import type { DynamicFormView } from "@/lib/forms/dynamic-field";

/** Dati serializzabili per le azioni dell'area "ticketedit" nella vista ticket (calcolati da TicketExtraActions). */
export interface Choice {
  id: number;
  name: string;
}

export interface EditableEntry {
  id: number;
  type: "M" | "R" | "N";
  poster: string;
  created: string;
  title: string;
  body: string;
}

export interface CollaboratorItem {
  id: number;
  userId: number;
  name: string;
  email: string;
  active: boolean;
}

export interface RelatedItem {
  id: number;
  number: string;
  subject: string;
  parent: boolean;
}

export interface TicketExtraData {
  ticketId: number;
  number: string;
  can: {
    edit: boolean;
    collaborators: boolean;
    merge: boolean;
    link: boolean;
    overdue: boolean;
    ban: boolean;
    delete: boolean;
    editEntries: boolean;
  };
  /** form "Modifica" (Ticket::getUpdateInfo) */
  edit: {
    userId: number;
    userName: string;
    userEmail: string;
    source: string;
    topicId: number;
    slaId: number;
    /** scadenza per <input type="datetime-local"> */
    duedate: string;
    isClosed: boolean;
    topics: Choice[];
    slas: Choice[];
    sources: string[];
    forms: DynamicFormView[];
    /** valori attuali dei campi (`f.<id>` → valori) */
    values: Record<string, string[]>;
    /** campi modificabili singolarmente (ajax editField) */
    fields: { key: string; label: string; kind: "topic" | "sla" | "source" | "duedate" | "form"; fieldId?: number }[];
  };
  collaborators: CollaboratorItem[];
  /** ticket collegati/uniti a questo (padre e figli) */
  related: { mergeType: "combine" | "separate" | "visual"; tickets: RelatedItem[] };
  /** stati per il dialogo di merge */
  closedStatuses: Choice[];
  /** stato del figlio preselezionato (stato chiuso "interno", non disattivabile) */
  defaultChildStatusId: number;
  parentStatuses: Choice[];
  isOverdue: boolean;
  ownerEmail: string;
  banned: boolean;
  /** stato "deleted" per l'eliminazione */
  deletedStatusId: number | null;
  hasChildren: boolean;
  entries: EditableEntry[];
}

export type ExtraKind = "edit" | "field" | "owner" | "collaborators" | "merge" | "link" | "overdue" | "ban" | "unban" | "delete" | "entry";
