/**
 * Schema serializzabile dei form dell'area admin: la pagina (server component) descrive i campi con
 * i nomi del POST di scp/*.php, il componente client AdminForm li disegna e invia un FormData che la
 * server action converte nelle `$vars` del PHP (parsePhpForm).
 */
export interface Opt {
  value: string;
  label: string;
}

interface Base {
  name: string;
  label: string;
  hint?: string;
  /** colonne occupate nella griglia a 2 colonne (default 1) */
  wide?: boolean;
}

export type FormField =
  | (Base & { kind: "text" | "email" | "password" | "number" | "url" | "date" | "time"; value?: string; required?: boolean; placeholder?: string })
  | (Base & { kind: "textarea"; value?: string; rows?: number; html?: boolean })
  | (Base & { kind: "select"; value?: string; options: Opt[]; required?: boolean })
  | (Base & { kind: "radio"; value?: string; options: Opt[] })
  | (Base & { kind: "checkbox"; checked?: boolean; value?: string })
  | (Base & { kind: "checkboxes"; values: string[]; options: Opt[]; groups?: { title: string; options: Opt[] }[] })
  | { kind: "hidden"; name: string; value: string }
  | { kind: "info"; name: string; label: string; text: string; wide?: boolean }
  | (Base & {
      kind: "access";
      /** nomi del POST: `${ids}[]`, `${role}[id]`, `${alerts}[id]` */
      ids: string;
      role?: string;
      alerts?: string;
      choices: Opt[];
      roles?: Opt[];
      selected: { id: string; role?: string; alerts?: boolean }[];
    });

export interface FormSection {
  title: string;
  desc?: string;
  fields: FormField[];
}

export interface AdminFormState {
  status: "idle" | "saved" | "error";
  /** codici d'errore per campo (chiavi come nel PHP), `err` per l'errore generale */
  errors?: Record<string, string>;
  nonce?: number;
}

export const IDLE: AdminFormState = { status: "idle" };
