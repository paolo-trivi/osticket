/**
 * Interpretazione di SHOW GRANTS FOR CURRENT_USER() (MariaDB e MySQL), senza accesso al DB.
 *
 * TailTicket deve poter solo leggere e scrivere righe: SELECT, INSERT, UPDATE, DELETE sullo schema di
 * osTicket. Qualunque privilegio DDL o amministrativo (ALL, CREATE, ALTER, DROP, INDEX, TRIGGER,
 * SUPER, GRANT OPTION, FILE, PROCESS...) sullo schema o globale permetterebbe a un errore del codice
 * di modificare la struttura del DB di osTicket: il doctor lo blocca.
 *
 * Le righe originali NON vanno mai mostrate: MariaDB vi include l'hash della password
 * ("IDENTIFIED BY PASSWORD '*...'"). Nei risultati compaiono solo privilegi e ambiti.
 */

/** Privilegi necessari e sufficienti. */
const REQUIRED_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
/** Superflui ma innocui (solo lettura di metadati). */
const HARMLESS = new Set(["SHOW VIEW", "SHOW DATABASES"]);
const ALLOWED = new Set<string>([...REQUIRED_PRIVILEGES, "USAGE"]);

type ScopeKind = "global" | "schema" | "table" | "routine" | "proxy";

interface ParsedGrant {
  privileges: string[];
  scope: { kind: ScopeKind; db?: string; table?: string; label: string };
  grantOption: boolean;
}

interface ParsedLine {
  grant?: ParsedGrant;
  role?: string;
  /** riga non riconosciuta (né GRANT con ON né ruolo) */
  unparsed?: boolean;
}

interface GrantsAnalysis {
  /** privilegi non consentiti con il loro ambito, es. "ALL PRIVILEGES su `osticket`.*" */
  dangerous: string[];
  /** privilegi superflui ma innocui */
  unneeded: string[];
  /** privilegi necessari assenti a livello di schema o globale */
  missing: string[];
  /** i privilegi necessari mancanti sono concessi tabella per tabella: non verificati uno a uno */
  tableLevel: boolean;
  /** ruoli concessi all'utente: i loro privilegi non compaiono in SHOW GRANTS FOR CURRENT_USER() */
  roles: string[];
  /** righe non interpretate */
  unparsed: number;
}

/** Trova `needle` (es. " ON ") fuori da parentesi, backtick e apici, a partire da `from`. */
function findTopLevel(s: string, needle: string, from = 0): number {
  let depth = 0;
  let quote: string | null = null;
  const up = s.toUpperCase();
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && quote !== "`") i++;
      else if (ch === quote) {
        if (s[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "`" || ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && up.startsWith(needle, i)) return i;
  }
  return -1;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = findTopLevel(s, sep); i >= 0; i = findTopLevel(s, sep, start)) {
    out.push(s.slice(start, i));
    start = i + sep.length;
  }
  out.push(s.slice(start));
  return out;
}

/** Toglie backtick o apici da un identificatore (`a``b` → a`b). */
function unquote(id: string): string {
  const t = id.trim();
  if (t.length >= 2 && (t[0] === "`" || t[0] === "'" || t[0] === '"') && t.endsWith(t[0])) {
    const q = t[0];
    return t
      .slice(1, -1)
      .split(q + q)
      .join(q);
  }
  return t;
}

function parseScope(raw: string): ParsedGrant["scope"] {
  let s = raw.trim();
  let routine = false;
  const kw = /^(PACKAGE BODY|PACKAGE|PROCEDURE|FUNCTION)\s+/i.exec(s);
  if (kw) {
    routine = true;
    s = s.slice(kw[0].length);
  }
  // GRANT PROXY ON 'utente'@'host': non è un ambito db.tabella
  if (/^['"`][^'"`]*['"`]@/.test(s) || (!s.includes(".") && s.includes("@"))) return { kind: "proxy", label: "PROXY" };
  const parts = splitTopLevel(s, ".").map(unquote);
  if (parts.length === 1) {
    // "*" = schema predefinito al momento del GRANT: non si sa quale, lo si tratta come globale
    return parts[0] === "*" ? { kind: "global", label: "*" } : { kind: "table", table: parts[0], label: raw.trim() };
  }
  const [db, table] = parts;
  if (db === "*" && table === "*") return { kind: "global", label: "*.* (globale)" };
  if (routine) return { kind: "routine", db, table, label: raw.trim() };
  if (table === "*") return { kind: "schema", db, label: `\`${db}\`.*` };
  return { kind: "table", db, table, label: `\`${db}\`.\`${table}\`` };
}

function normalizePrivilege(p: string): string {
  return p
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function parseGrantLine(line: string): ParsedLine {
  const s = line.trim();
  if (!/^GRANT\s/i.test(s)) return { unparsed: true };
  const body = s.replace(/^GRANT\s+/i, "");
  const on = findTopLevel(body, " ON ");
  const to = findTopLevel(body, " TO ");
  if (to < 0) return { unparsed: true };
  if (on < 0 || on > to) {
    // GRANT `ruolo` TO `utente`@`host`
    return {
      role: splitTopLevel(body.slice(0, to), ",").map(unquote).join(", "),
    };
  }
  const privileges = splitTopLevel(body.slice(0, on), ",").map(normalizePrivilege).filter(Boolean);
  const scope = parseScope(body.slice(on + 4, findTopLevel(body, " TO ", on + 4)));
  const grantOption = /\bWITH\b[^']*\bGRANT OPTION\b/i.test(body.slice(findTopLevel(body, " TO ", on + 4)));
  return { grant: { privileges, scope, grantOption } };
}

/** Nome di schema nei GRANT: `_` e `%` sono caratteri jolly, `\` li rende letterali. */
export function schemaPatternMatches(pattern: string, schema: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (ch === "_") re += ".";
    else if (ch === "%") re += ".*";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  // confronto senza distinzione di maiuscole: nel dubbio l'ambito si considera quello di osTicket
  return new RegExp(`^${re}$`, "i").test(schema);
}

/** L'ambito riguarda lo schema di osTicket (o è globale)? */
function concernsSchema(scope: ParsedGrant["scope"], schema: string): boolean {
  switch (scope.kind) {
    case "global":
    case "proxy":
      return true;
    case "schema":
      return schemaPatternMatches(scope.db ?? "", schema);
    case "table":
    case "routine":
      return scope.db === undefined || scope.db.toLowerCase() === schema.toLowerCase();
  }
}

export function analyzeGrants(lines: readonly string[], schema: string): GrantsAnalysis {
  const out: GrantsAnalysis = {
    dangerous: [],
    unneeded: [],
    missing: [],
    tableLevel: false,
    roles: [],
    unparsed: 0,
  };
  const present = new Set<string>();
  let tableGrants = false;
  for (const line of lines) {
    const parsed = parseGrantLine(line);
    if (parsed.unparsed) {
      out.unparsed++;
      continue;
    }
    if (parsed.role) {
      out.roles.push(parsed.role);
      continue;
    }
    const g = parsed.grant!;
    if (!concernsSchema(g.scope, schema)) continue;
    const where = g.scope.kind === "proxy" ? "" : ` su ${g.scope.label}`;
    const privileges = g.grantOption ? [...g.privileges, "GRANT OPTION"] : g.privileges;
    for (const p of privileges) {
      const priv = p === "ALL" ? "ALL PRIVILEGES" : p;
      if (g.scope.kind === "global" || g.scope.kind === "schema") {
        if (priv === "ALL PRIVILEGES") REQUIRED_PRIVILEGES.forEach((r) => present.add(r));
        else present.add(priv);
      } else if (g.scope.kind === "table" && (REQUIRED_PRIVILEGES as readonly string[]).includes(priv)) {
        tableGrants = true;
      }
      if (ALLOWED.has(priv)) continue;
      const label = `${priv}${where}`;
      if (HARMLESS.has(priv)) {
        if (!out.unneeded.includes(label)) out.unneeded.push(label);
      } else if (!out.dangerous.includes(label)) {
        out.dangerous.push(label);
      }
    }
  }
  out.missing = REQUIRED_PRIVILEGES.filter((r) => !present.has(r));
  out.tableLevel = out.missing.length > 0 && tableGrants;
  return out;
}

/** Identificatore per un GRANT a livello di schema: `_` e `%` resi letterali. */
function grantSchemaIdent(schema: string): string {
  return `\`${schema.replace(/`/g, "``").replace(/([_%])/g, "\\$1")}\``;
}

/** Istruzioni consigliate (utente e host restano segnaposto: mai credenziali). */
export function recommendedGrant(schema: string): string {
  return ["REVOKE ALL PRIVILEGES, GRANT OPTION FROM '<utente>'@'<host>';", `GRANT ${REQUIRED_PRIVILEGES.join(", ")} ON ${grantSchemaIdent(schema)}.* TO '<utente>'@'<host>';`].join("\n");
}
