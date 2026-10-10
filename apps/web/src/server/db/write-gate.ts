import type { CompiledQuery, DatabaseConnection, Dialect, Driver, Kysely, QueryCompiler, QueryResult, TransactionSettings } from "kysely";

import { currentWriteContext, gateWriteMode, inModeProbe, ReadOnlyModeError, writeAllowed, type WriteContextInfo, type WriteMode } from "../system/write-mode";
import { journalEnabled, journalWrite, type JournalTables } from "../system/write-journal";

/**
 * Gate unico delle scritture sul DB osTicket (TAILTICKET_MODE, src/server/system/write-mode.ts).
 *
 * Non è un plugin Kysely (transformQuery è sincrono e la modalità effettiva si calcola in modo
 * asincrono) ma un involucro del driver: ogni query arriva qui già compilata, con il testo SQL finale,
 * sia dai query builder sia da `sql` scritto a mano (RawNode) sia da CompiledQuery.raw. Le query che
 * non sono letture (classifySql) passano solo se lo scope corrente (withWriteScope) è consentito dalla
 * modalità effettiva, altrimenti ReadOnlyModeError prima di raggiungere il DB.
 * BEGIN/COMMIT/ROLLBACK passano dal driver interno e non sono controllati; SELECT … FOR UPDATE è una lettura.
 *
 * Lo stesso involucro raccoglie tabelle e verbi delle scritture di ogni transazione per il registro delle
 * scritture (write-journal.ts): una voce al commit (o subito per le scritture fuori transazione), nessuna
 * al rollback.
 */

interface QueryClass {
  write: boolean;
  /** primo verbo SQL in minuscolo (insert, update, delete, replace, …) */
  verb: string;
  /** tabelle di destinazione (nomi reali, con il prefisso dell'installazione) */
  tables: string[];
}

const READ_VERBS = new Set(["select", "show", "describe", "desc", "explain", "values", "help"]);
/** Controllo della transazione, variabili di sessione, KILL QUERY del driver: non modificano dati. */
const CONTROL_VERBS = new Set(["begin", "start", "commit", "rollback", "savepoint", "release", "set", "kill"]);

/** Toglie spazi, commenti e parentesi iniziali. */
function stripLead(sql: string): string {
  let s = sql;
  for (;;) {
    const next = s
      .replace(/^\s+/, "")
      .replace(/^\/\*[\s\S]*?\*\//, "")
      .replace(/^(?:--\s|#)[^\n]*(?:\n|$)/, "")
      .replace(/^\(/, "");
    if (next === s) return s;
    s = next;
  }
}

/** Identificatori tra backtick che non sono parte di `alias`.`colonna`. */
function quotedTables(region: string): string[] {
  return [...region.matchAll(/(?<![.`])`((?:[^`]|``)+)`(?!\.)/g)].map((m) => m[1].replace(/``/g, "`"));
}

function firstBare(region: string): string[] {
  const m = /^\s*([A-Za-z_][\w$]*)/.exec(region);
  return m ? [m[1]] : [];
}

function targetTables(verb: string, rest: string): string[] {
  let found: string[] = [];
  if (verb === "insert" || verb === "replace") {
    const m = /\binto\s+(`(?:[^`]|``)+`|[A-Za-z_][\w$]*)/i.exec(rest);
    found = m ? [m[1].replace(/^`|`$/g, "").replace(/``/g, "`")] : [];
  } else if (verb === "update") {
    const region = rest.split(/\bset\b/i)[0];
    found = quotedTables(region);
    if (!found.length) found = firstBare(region.replace(/^\s*(?:low_priority\s+|ignore\s+)*/i, ""));
  } else if (verb === "delete") {
    const from = /\bfrom\b/i.exec(rest);
    const region = from ? rest.slice(from.index + 4).split(/\b(?:where|order\s+by|limit|returning)\b/i)[0] : "";
    found = quotedTables(region);
    if (!found.length) found = firstBare(region);
  } else {
    found = quotedTables(rest).slice(0, 1);
  }
  return [...new Set(found)];
}

/** Classifica una query dal testo SQL compilato (e dal tipo di nodo Kysely, se noto). */
export function classifySql(sql: string, nodeKind?: string): QueryClass {
  if (nodeKind === "SelectQueryNode") return { write: false, verb: "select", tables: [] };
  const text = stripLead(sql);
  const m = /^([A-Za-z]+)/.exec(text);
  const verb = (m?.[1] ?? "").toLowerCase();
  const rest = text.slice(verb.length);
  if (!verb) return { write: true, verb: "unknown", tables: [] };
  if (verb === "select") {
    // SELECT … INTO OUTFILE/DUMPFILE scrive file sul server del DB
    if (/\binto\s+(?:outfile|dumpfile)\b/i.test(rest)) return { write: true, verb, tables: [] };
    return { write: false, verb, tables: [] };
  }
  if (READ_VERBS.has(verb)) return { write: false, verb, tables: [] };
  if (verb === "with") {
    // CTE: lettura, salvo una scrittura nel corpo (UPDATE non preceduto da FOR)
    const w = /\b(insert|replace|delete)\b|(?<!\bfor\s)\bupdate\b/i.exec(rest);
    if (!w) return { write: false, verb: "select", tables: [] };
    const wverb = (w[1] ?? "update").toLowerCase();
    return {
      write: true,
      verb: wverb,
      tables: targetTables(wverb, rest.slice(w.index + w[0].length)),
    };
  }
  if (CONTROL_VERBS.has(verb)) {
    if (verb === "set" && /^\s*(?:global\b|persist\b|password\b|role\b|default\s+role\b|@@global\.)/i.test(rest)) {
      return { write: true, verb, tables: [] };
    }
    return { write: false, verb, tables: [] };
  }
  return { write: true, verb, tables: targetTables(verb, rest) };
}

function classifyCompiled(q: CompiledQuery): QueryClass {
  return classifySql(q.sql, q.query?.kind);
}

// ── Involucro del driver ─────────────────────────────────────────────────────────────────────────────

interface WriteGateOptions {
  /** modalità da applicare alle scritture (null = nessun controllo); default gateWriteMode() */
  mode?: () => Promise<WriteMode | null>;
  /** scrittura completata (commit o autocommit); default il registro delle scritture, se attivo */
  completed?: (entry: CompletedWrite) => void;
  /** raccolta delle tabelle attiva; default journalEnabled() */
  collect?: () => boolean;
}

export interface CompletedWrite {
  context: WriteContextInfo | undefined;
  tables: JournalTables;
}

const warnedUnscoped = new Set<string>();

class WriteGate {
  readonly mode: () => Promise<WriteMode | null>;
  readonly completed: (entry: CompletedWrite) => void;
  readonly collect: () => boolean;

  constructor(opts: WriteGateOptions) {
    this.mode = opts.mode ?? gateWriteMode;
    this.completed = opts.completed ?? ((e) => journalWrite(e.context, e.tables));
    this.collect = opts.collect ?? journalEnabled;
  }

  async check(c: QueryClass): Promise<void> {
    const ctx = currentWriteContext();
    if (inModeProbe()) throw new ReadOnlyModeError(ctx?.scope ?? "admin", "readonly");
    const mode = await this.mode();
    if (mode === null) return;
    // senza scope: la più restrittiva (un punto di scrittura non classificato non passa in "operational")
    const scope = ctx?.scope ?? "admin";
    if (!ctx) {
      const key = `${c.verb} ${c.tables.join(",")}`;
      if (!warnedUnscoped.has(key)) {
        warnedUnscoped.add(key);
        console.warn(`[write-gate] scrittura senza scope (${key}): trattata come "admin"`);
      }
    }
    if (!writeAllowed(mode, scope)) throw new ReadOnlyModeError(scope, mode);
  }
}

class GatedConnection implements DatabaseConnection {
  #inTx = false;
  #pending: {
    context: WriteContextInfo | undefined;
    tables: Map<string, Set<string>>;
  } | null = null;
  cancelQuery?: DatabaseConnection["cancelQuery"];
  collectSessionInfo?: DatabaseConnection["collectSessionInfo"];
  killSession?: DatabaseConnection["killSession"];

  constructor(
    readonly inner: DatabaseConnection,
    private readonly gate: WriteGate,
  ) {
    if (inner.cancelQuery) this.cancelQuery = (p) => inner.cancelQuery!(p);
    if (inner.collectSessionInfo) this.collectSessionInfo = () => inner.collectSessionInfo!();
    if (inner.killSession) this.killSession = (p) => inner.killSession!(p);
  }

  async executeQuery<R>(compiledQuery: CompiledQuery, options?: Parameters<DatabaseConnection["executeQuery"]>[1]): Promise<QueryResult<R>> {
    const c = classifyCompiled(compiledQuery);
    if (!c.write) return this.inner.executeQuery<R>(compiledQuery, options);
    await this.gate.check(c);
    const result = await this.inner.executeQuery<R>(compiledQuery, options);
    this.#recordWrite(c);
    return result;
  }

  async *streamQuery<R>(compiledQuery: CompiledQuery, chunkSize: number, options?: Parameters<DatabaseConnection["streamQuery"]>[2]): AsyncIterableIterator<QueryResult<R>> {
    const c = classifyCompiled(compiledQuery);
    if (c.write) await this.gate.check(c);
    yield* this.inner.streamQuery<R>(compiledQuery, chunkSize, options);
    if (c.write) this.#recordWrite(c);
  }

  beginTx(): void {
    this.#inTx = true;
    this.#pending = null;
  }

  endTx(committed: boolean): void {
    const p = this.#pending;
    this.#inTx = false;
    this.#pending = null;
    if (committed && p) this.#emit(p);
  }

  #recordWrite(c: QueryClass): void {
    if (!this.gate.collect()) return;
    const p = this.#inTx
      ? (this.#pending ??= {
          context: currentWriteContext(),
          tables: new Map(),
        })
      : {
          context: currentWriteContext(),
          tables: new Map<string, Set<string>>(),
        };
    for (const t of c.tables.length ? c.tables : ["?"]) {
      const verbs = p.tables.get(t) ?? new Set<string>();
      verbs.add(c.verb);
      p.tables.set(t, verbs);
    }
    if (!this.#inTx) this.#emit(p);
  }

  #emit(p: { context: WriteContextInfo | undefined; tables: Map<string, Set<string>> }): void {
    const tables: JournalTables = {};
    for (const [t, verbs] of p.tables) tables[t] = [...verbs].sort();
    try {
      this.gate.completed({ context: p.context, tables });
    } catch (err) {
      console.error("[write-gate] registro delle scritture non aggiornato", err);
    }
  }
}

class WriteGateDriver implements Driver {
  readonly #inner: Driver;
  readonly #gate: WriteGate;
  readonly #wrapped = new WeakMap<DatabaseConnection, GatedConnection>();

  constructor(inner: Driver, gate: WriteGate) {
    this.#inner = inner;
    this.#gate = gate;
  }

  #unwrap(c: DatabaseConnection): DatabaseConnection {
    return c instanceof GatedConnection ? c.inner : c;
  }

  init(options?: Parameters<Driver["init"]>[0]): Promise<void> {
    return this.#inner.init(options);
  }

  async acquireConnection(options?: Parameters<Driver["acquireConnection"]>[0]): Promise<DatabaseConnection> {
    const c = await this.#inner.acquireConnection(options);
    let w = this.#wrapped.get(c);
    if (!w) {
      w = new GatedConnection(c, this.#gate);
      this.#wrapped.set(c, w);
    }
    return w;
  }

  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    await this.#inner.beginTransaction(this.#unwrap(connection), settings);
    if (connection instanceof GatedConnection) connection.beginTx();
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    try {
      await this.#inner.commitTransaction(this.#unwrap(connection));
    } catch (err) {
      if (connection instanceof GatedConnection) connection.endTx(false);
      throw err;
    }
    if (connection instanceof GatedConnection) connection.endTx(true);
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    if (connection instanceof GatedConnection) connection.endTx(false);
    await this.#inner.rollbackTransaction(this.#unwrap(connection));
  }

  async savepoint(connection: DatabaseConnection, name: string, compileQuery: QueryCompiler["compileQuery"]): Promise<void> {
    if (!this.#inner.savepoint) throw new Error("savepoint non supportati dal driver");
    await this.#inner.savepoint(this.#unwrap(connection), name, compileQuery);
  }

  async rollbackToSavepoint(connection: DatabaseConnection, name: string, compileQuery: QueryCompiler["compileQuery"]): Promise<void> {
    if (!this.#inner.rollbackToSavepoint) throw new Error("savepoint non supportati dal driver");
    await this.#inner.rollbackToSavepoint(this.#unwrap(connection), name, compileQuery);
  }

  async releaseSavepoint(connection: DatabaseConnection, name: string, compileQuery: QueryCompiler["compileQuery"]): Promise<void> {
    if (!this.#inner.releaseSavepoint) throw new Error("savepoint non supportati dal driver");
    await this.#inner.releaseSavepoint(this.#unwrap(connection), name, compileQuery);
  }

  releaseConnection(connection: DatabaseConnection, options?: Parameters<Driver["releaseConnection"]>[1]): Promise<void> {
    return this.#inner.releaseConnection(this.#unwrap(connection), options);
  }

  destroy(options?: Parameters<Driver["destroy"]>[0]): Promise<void> {
    return this.#inner.destroy(options);
  }
}

/** Dialetto con il gate delle scritture attorno al driver del dialetto dato. */
export function withWriteGate(dialect: Dialect, opts: WriteGateOptions = {}): Dialect {
  const gate = new WriteGate(opts);
  return {
    createDriver: () => new WriteGateDriver(dialect.createDriver(), gate),
    createQueryCompiler: () => dialect.createQueryCompiler(),
    createAdapter: () => dialect.createAdapter(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createIntrospector: (db: Kysely<any>) => dialect.createIntrospector(db),
  };
}
