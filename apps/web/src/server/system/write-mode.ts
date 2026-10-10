import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { schemaStatus } from "./schema-compat";

/**
 * Modalità di scrittura di TailTicket (TAILTICKET_MODE), per collegarsi in sicurezza a un osTicket già
 * in produzione:
 *  - "readonly": nessuna scrittura sul DB osTicket (il login funziona, senza le scritture accessorie);
 *  - "operational": lavoro quotidiano di agenti e clienti (ticket, task, utenti, profilo, login, lock,
 *    allegati, syslog), niente area admin né impostazioni;
 *  - "full": tutto.
 * Variabile assente = "full" (lo stack integrato e i test non cambiano); valore non valido = "readonly".
 * La modalità effettiva, anche senza variabile, scende a "readonly" se lo schema del DB non è
 * verificato (schema-compat.ts) o se il doctor segnala problemi critici: il gate e l'interfaccia
 * (write-mode-ui.ts) usano la stessa modalità effettiva e la stessa cache. Con schema verificato e
 * doctor senza problemi il costo è una lettura di config ogni CACHE_MS, nessuna scrittura.
 *
 * Il controllo vero è nel gate delle query (src/server/db/write-gate.ts): ogni scrittura deve avvenire
 * dentro uno scope (withWriteScope; runWrite = operational, adminWrite = admin). Una scrittura senza
 * scope vale come "admin" (la più restrittiva).
 */
export type WriteMode = "readonly" | "operational" | "full";
export type WriteScope = "operational" | "admin";

const MODES: readonly WriteMode[] = ["readonly", "operational", "full"];
const MODE_ENV = "TAILTICKET_MODE";

/** Durata della cache della modalità effettiva (letture di schema e doctor). */
const CACHE_MS = 5_000;

export function configuredWriteMode(env: Record<string, string | undefined> = process.env): WriteMode {
  const raw = env[MODE_ENV];
  if (raw === undefined || raw.trim() === "") return "full";
  const v = raw.trim().toLowerCase() as WriteMode;
  return MODES.includes(v) ? v : "readonly";
}

/** TAILTICKET_MODE impostata esplicitamente (diagnostica; il gate controlla comunque le scritture). */
export function writeModeConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return (env[MODE_ENV] ?? "").trim() !== "";
}

export function writeAllowed(mode: WriteMode, scope: WriteScope): boolean {
  if (mode === "full") return true;
  if (mode === "operational") return scope === "operational";
  return false;
}

export class ReadOnlyModeError extends Error {
  readonly code = "read_only" as const;

  constructor(
    readonly scope: WriteScope,
    readonly mode: WriteMode = "readonly",
  ) {
    super(`Scrittura "${scope}" non consentita in modalità ${mode} (TAILTICKET_MODE)`);
    this.name = "ReadOnlyModeError";
  }
}

export function isReadOnlyError(err: unknown): err is ReadOnlyModeError {
  return err instanceof ReadOnlyModeError || (err as { code?: unknown } | null)?.code === "read_only";
}

/**
 * Esito restituito da runWrite/adminWrite al posto del risultato quando la scrittura non è consentita.
 * Ha la forma degli esiti più comuni (SaveResult, MassResult, `{ error }`, `{ ok: false, errors }`),
 * così le action lo propagano senza casi speciali.
 */
export interface ReadOnlyResult {
  ok: false;
  error: "read_only";
  errors: Record<string, string>;
  num: 0;
  /** sempre assenti: solo per la compatibilità con gli esiti che li prevedono */
  id?: undefined;
  fields?: undefined;
  detail?: undefined;
}

/** Nuovo oggetto a ogni chiamata: alcune action completano `errors` dell'esito. */
export function readOnlyResult(): ReadOnlyResult {
  return {
    ok: false,
    error: "read_only",
    errors: { err: "read_only" },
    num: 0,
  };
}

// ── Scope delle scritture ────────────────────────────────────────────────────────────────────────────

/** Attore registrato nel registro delle scritture (mai nomi o indirizzi). */
export interface WriteActor {
  type: "agent" | "client" | "system";
  id?: number;
}

export interface WriteContextInfo {
  scope: WriteScope;
  actor?: WriteActor;
  /** nome dell'operazione (es. "agent.login"), oppure la action o la route */
  op?: string;
}

const g = globalThis as typeof globalThis & {
  __ttWriteScope?: AsyncLocalStorage<WriteContextInfo>;
  __ttModeProbe?: AsyncLocalStorage<true>;
  __ttModeCache?: { at: number; value: EffectiveWriteMode } | null;
  __ttModeInflight?: Promise<EffectiveWriteMode> | null;
};
const scopeStorage = (g.__ttWriteScope ??= new AsyncLocalStorage<WriteContextInfo>());
const probeStorage = (g.__ttModeProbe ??= new AsyncLocalStorage<true>());

/** Esegue fn con lo scope di scrittura indicato; attore e operazione si ereditano dallo scope esterno. */
export function withWriteScope<T>(scope: WriteScope, fn: () => Promise<T>, meta: Omit<WriteContextInfo, "scope"> = {}): Promise<T> {
  const parent = scopeStorage.getStore();
  const info: WriteContextInfo = { ...parent, ...stripUndefined(meta), scope };
  return scopeStorage.run(info, fn);
}

export function currentWriteContext(): WriteContextInfo | undefined {
  return scopeStorage.getStore();
}

/** Dentro il calcolo della modalità effettiva (letture di schema e doctor): nessuna scrittura ammessa. */
export function inModeProbe(): boolean {
  return probeStorage.getStore() === true;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ── Modalità effettiva ───────────────────────────────────────────────────────────────────────────────

export interface EffectiveWriteMode {
  configured: WriteMode;
  effective: WriteMode;
  reasons: string[];
}

/** Modalità configurata abbassata a "readonly" se lo schema non è verificato o il doctor segnala problemi. */
export async function effectiveWriteMode(): Promise<EffectiveWriteMode> {
  const configured = configuredWriteMode();
  const reasons: string[] = [];
  try {
    const { loadConfigNamespace } = await import("../config/config");
    if (!schemaStatus(await loadConfigNamespace("core")).writable) reasons.push("schema_unverified");
  } catch {
    reasons.push("schema_unreadable");
  }
  try {
    const { criticalDoctorFailures } = await import("./doctor/runtime");
    for (const code of await criticalDoctorFailures()) reasons.push(`doctor:${code}`);
  } catch {
    reasons.push("doctor_failed");
  }
  return {
    configured,
    effective: reasons.length ? "readonly" : configured,
    reasons,
  };
}

function refreshMode(): Promise<EffectiveWriteMode> {
  g.__ttModeInflight ??= probeStorage
    .run(true, effectiveWriteMode)
    .then((value) => {
      g.__ttModeCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      g.__ttModeInflight = null;
    });
  return g.__ttModeInflight;
}

/** Modalità effettiva con cache breve (CACHE_MS). */
export async function cachedEffectiveWriteMode(): Promise<EffectiveWriteMode> {
  const c = g.__ttModeCache;
  if (c && Date.now() - c.at < CACHE_MS) return c.value;
  return refreshMode();
}

/**
 * Modalità da applicare a una query di scrittura (gate). Con un valore in cache, anche scaduto, non si
 * attende: il rinnovo parte in background (una query di scrittura tiene già occupata una connessione
 * del pool, attenderne un'altra rischierebbe lo stallo). runWrite, adminWrite e canWrite leggono la
 * modalità prima di aprire la transazione, quindi la cache è di norma già fresca.
 */
export async function gateWriteMode(): Promise<WriteMode | null> {
  const c = g.__ttModeCache;
  if (c) {
    if (Date.now() - c.at >= CACHE_MS) refreshMode().catch(() => {});
    return c.value.effective;
  }
  return (await refreshMode()).effective;
}

/** Scrittura consentita nello scope? (modalità effettiva, con la cache breve) */
export async function canWrite(scope: WriteScope): Promise<boolean> {
  return writeAllowed((await cachedEffectiveWriteMode()).effective, scope);
}

/**
 * Scrittura accessoria (lastlogin, rehash della password, syslog…): eseguita nello scope se consentita,
 * altrimenti saltata in silenzio. Restituisce undefined se saltata.
 */
export async function writeIfAllowed<T>(scope: WriteScope, meta: Omit<WriteContextInfo, "scope"> | undefined, fn: () => Promise<T>): Promise<T | undefined> {
  if (!(await canWrite(scope))) return undefined;
  try {
    return await withWriteScope(scope, fn, meta);
  } catch (err) {
    if (isReadOnlyError(err)) return undefined;
    throw err;
  }
}
