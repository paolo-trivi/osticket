/**
 * Parametri della board Kanban (`/agent/board`) nei search params dell'URL, così una vista si può condividere.
 * Modulo puro (nessun accesso al DB): usato dal server e dai componenti client per costruire i link.
 */

export const BOARD_GROUPS = ["status", "priority", "assignee", "dept"] as const;
export const BOARD_LANES = ["none", "priority", "assignee", "dept"] as const;

export type BoardGroupBy = (typeof BOARD_GROUPS)[number];
export type BoardLaneBy = (typeof BOARD_LANES)[number];

/** Sorgente dei ticket: tutti i ticket visibili all'agente oppure una coda (id). */
export type BoardSource = "all" | number;

export interface BoardParams {
  source: BoardSource;
  group: BoardGroupBy;
  lane: BoardLaneBy;
  /** solo i ticket assegnati a me */
  mine: boolean;
  /** solo i ticket non assegnati (né agente né team) */
  unassigned: boolean;
  /** solo i ticket scaduti */
  overdue: boolean;
  /** priorità (priority_id) ammesse; vuoto = tutte */
  prio: number[];
  /** ricerca rapida (numero, email o testo, come la barra di ricerca dei ticket) */
  q: string;
  /** includi anche i ticket chiusi da più di RECENT_CLOSED_DAYS giorni */
  older: boolean;
}

/** I ticket chiusi compaiono sulla board solo se chiusi negli ultimi N giorni (salvo `older`). */
export const RECENT_CLOSED_DAYS = 14;

export const DEFAULT_BOARD_PARAMS: BoardParams = {
  source: "all",
  group: "status",
  lane: "none",
  mine: false,
  unassigned: false,
  overdue: false,
  prio: [],
  q: "",
  older: false,
};

/** Chiavi dei search params gestite dalla board. */
export const BOARD_PARAM_KEYS = [
  "src",
  "group",
  "lane",
  "mine",
  "unassigned",
  "overdue",
  "prio",
  "q",
  "older",
] as const;

type RawParams =
  Record<string, string | string[] | undefined> | URLSearchParams;

function first(sp: RawParams, key: string): string | undefined {
  if (sp instanceof URLSearchParams) return sp.get(key) ?? undefined;
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

const flag = (v: string | undefined) => v === "1" || v === "true";

export function parseBoardParams(sp: RawParams): BoardParams {
  const src = first(sp, "src");
  const group = first(sp, "group");
  const lane = first(sp, "lane");
  const prio = (first(sp, "prio") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{1,9}$/.test(s))
    .map(Number)
    .filter((n) => n > 0);
  const out: BoardParams = {
    source:
      src && /^\d{1,9}$/.test(src) && Number(src) > 0 ? Number(src) : "all",
    group: (BOARD_GROUPS as readonly string[]).includes(group ?? "")
      ? (group as BoardGroupBy)
      : "status",
    lane: (BOARD_LANES as readonly string[]).includes(lane ?? "")
      ? (lane as BoardLaneBy)
      : "none",
    mine: flag(first(sp, "mine")),
    unassigned: flag(first(sp, "unassigned")),
    overdue: flag(first(sp, "overdue")),
    prio: [...new Set(prio)].sort((a, b) => a - b),
    q: (first(sp, "q") ?? "").trim().slice(0, 200),
    older: flag(first(sp, "older")),
  };
  // Swimlane uguale al raggruppamento: nessuna informazione in più
  if (out.lane === out.group) out.lane = "none";
  // "Solo miei" e "Non assegnati" si escludono: prevale "Solo miei"
  if (out.mine && out.unassigned) out.unassigned = false;
  return out;
}

/** Search params (solo i valori diversi dal default) nell'ordine di BOARD_PARAM_KEYS. */
export function boardSearchParams(p: BoardParams): URLSearchParams {
  const qs = new URLSearchParams();
  if (p.source !== "all") qs.set("src", String(p.source));
  if (p.group !== "status") qs.set("group", p.group);
  if (p.lane !== "none" && p.lane !== p.group) qs.set("lane", p.lane);
  if (p.mine) qs.set("mine", "1");
  if (p.unassigned && !p.mine) qs.set("unassigned", "1");
  if (p.overdue) qs.set("overdue", "1");
  if (p.prio.length)
    qs.set("prio", [...p.prio].sort((a, b) => a - b).join(","));
  if (p.q) qs.set("q", p.q);
  if (p.older) qs.set("older", "1");
  return qs;
}

export function boardHref(p: BoardParams): string {
  const s = boardSearchParams(p).toString();
  return s ? `/agent/board?${s}` : "/agent/board";
}

/** Ci sono filtri attivi (oltre a sorgente, raggruppamento e swimlane)? */
export function hasActiveFilters(p: BoardParams): boolean {
  return p.mine || p.unassigned || p.overdue || p.prio.length > 0 || !!p.q;
}
