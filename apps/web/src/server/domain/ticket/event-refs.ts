/**
 * Lettura dei dati degli eventi del thread come ThreadEvent::template e le descrizioni degli eventi
 * (include/class.thread.php): funzioni pure, i nomi dal DB li risolve la vista ticket.
 */

/**
 * Valore `{<Tipo>data.chiave}`: un id, oppure `[id, nome]` (il nome è la riserva se l'oggetto non esiste
 * più). Gli stati del PHP 1.18 sono registrati come `[id, "Nome"]`.
 */
export function eventRef(v: unknown): { id: number | null; fallback: string } {
  if (Array.isArray(v)) {
    const [id, fallback] = v as unknown[];
    return {
      id: toId(id),
      fallback: typeof fallback === "string" ? fallback : "",
    };
  }
  return { id: toId(v), fallback: "" };
}

function toId(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v) && Number(v) > 0) return Number(v);
  return null;
}

interface EventCollab {
  /** id dell'utente (chiave dei dati), null per il proprietario di un figlio unito (chiave vuota) */
  id: number | null;
  /** nome registrato nell'evento (`name`, o il valore stesso se è una stringa) */
  name: string;
  /** origine dell'aggiunta (`src`, es. "Email (to)") */
  src: string;
}

/** CollaboratorEvent: utenti aggiunti (`add`) o rimossi (`del`), nell'ordine dei dati. */
export function eventCollabs(data: Record<string, unknown>): {
  added: EventCollab[];
  removed: EventCollab[];
} {
  const list = (v: unknown): EventCollab[] =>
    v && typeof v === "object"
      ? Object.entries(v as Record<string, unknown>).map(([k, c]) => {
          const o = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
          return {
            id: toId(k),
            name: typeof c === "string" ? c : String(o.name ?? ""),
            src: typeof o.src === "string" ? o.src : "",
          };
        })
      : [];
  return { added: list(data.add), removed: list(data.del) };
}

/** Valore di una modifica (to_database) leggibile: liste e scelte `{"chiave":"Etichetta"}` come elenco. */
export function eventValueText(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (Array.isArray(v)) return v.map(eventValueText).filter(Boolean).join(", ");
  if (typeof v === "object")
    return Object.values(v as Record<string, unknown>)
      .map(eventValueText)
      .filter(Boolean)
      .join(", ");
  const s = String(v);
  if (/^\s*[[{]/.test(s)) {
    try {
      const parsed: unknown = JSON.parse(s);
      if (parsed && typeof parsed === "object") return eventValueText(parsed);
    } catch {
      // testo che inizia per parentesi: resta com'è
    }
  }
  return s;
}

/** EditEvent: colonne del ticket descritte con `[vecchio, nuovo]`, nell'ordine del PHP. */
export const EDIT_EVENT_COLUMNS = ["topic_id", "sla_id", "duedate", "user_id", "source"] as const;
export type EditEventColumn = (typeof EDIT_EVENT_COLUMNS)[number];

/** Coppia `[vecchio, nuovo]` di una modifica (altri formati: solo il nuovo valore). */
export function eventPair(v: unknown): [unknown, unknown] {
  return Array.isArray(v) ? [v[0], v[1]] : [null, v];
}
