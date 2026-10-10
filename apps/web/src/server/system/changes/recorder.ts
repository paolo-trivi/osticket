import { AsyncLocalStorage } from "node:async_hooks";

import { MAX_CHANGE_ROWS, type NotUndoableReason } from "@/lib/changes";

import type { ChangeEntry } from "./types";

/**
 * Raccolta delle righe di una modifica admin in corso (changeset.ts → withChangeset). Il gate delle
 * scritture (src/server/db/write-gate.ts) registra ogni scrittura in un lotto (ChangeBatch) della
 * transazione: al commit il lotto passa al recorder, al rollback si scarta. Una scrittura non
 * registrabile rende la modifica non annullabile (fail): da lì in poi niente più catture.
 */

/** Byte (JSON) al massimo delle righe di una modifica annullabile. */
const MAX_CHANGE_BYTES = 8 * 1024 * 1024;

interface ChangeFailure {
  reason: NotUndoableReason;
  detail: string;
}

function addTouched(into: Map<string, Set<string>>, tables: readonly string[], verb: string): void {
  for (const t of tables.length ? tables : ["?"]) {
    const verbs = into.get(t) ?? new Set<string>();
    verbs.add(verb);
    into.set(t, verbs);
  }
}

export class ChangeRecorder {
  entries: ChangeEntry[] = [];
  bytes = 0;
  failure: ChangeFailure | null = null;
  readonly touched = new Map<string, Set<string>>();

  /** `skipInsert`: tabelle i cui INSERT non si registrano (log in sola aggiunta: syslog). */
  constructor(readonly skipInsert: (table: string) => boolean = () => false) {}

  commit(batch: ChangeBatch): void {
    for (const [t, verbs] of batch.touched) for (const v of verbs) addTouched(this.touched, [t], v);
    if (this.failure) return;
    if (batch.failure) return this.fail(batch.failure);
    this.entries.push(...batch.entries);
    this.bytes += batch.bytes;
  }

  fail(f: ChangeFailure): void {
    if (this.failure) return;
    this.failure = f;
    this.entries = [];
    this.bytes = 0;
    console.warn(`[changes] modifica non annullabile (${f.reason}: ${f.detail})`);
  }
}

/** Scritture di una transazione (o di una singola query fuori transazione), in attesa del commit. */
export class ChangeBatch {
  entries: ChangeEntry[] = [];
  bytes = 0;
  failure: ChangeFailure | null = null;
  readonly touched = new Map<string, Set<string>>();

  constructor(readonly recorder: ChangeRecorder) {}

  /** Si registrano ancora righe? (né il lotto né la modifica sono già non annullabili) */
  get capturing(): boolean {
    return !this.failure && !this.recorder.failure;
  }

  /** Righe ancora registrabili nella modifica. */
  get budget(): number {
    return Math.max(0, MAX_CHANGE_ROWS - this.recorder.entries.length - this.entries.length);
  }

  touch(tables: readonly string[], verb: string): void {
    addTouched(this.touched, tables, verb);
  }

  add(entries: ChangeEntry[]): void {
    if (!this.capturing) return;
    for (const e of entries) this.bytes += JSON.stringify(e).length;
    this.entries.push(...entries);
    if (this.recorder.entries.length + this.entries.length > MAX_CHANGE_ROWS || this.recorder.bytes + this.bytes > MAX_CHANGE_BYTES) {
      this.fail({ reason: "too_large", detail: `${this.recorder.entries.length + this.entries.length} righe, ${this.recorder.bytes + this.bytes} byte` });
    }
  }

  fail(f: ChangeFailure): void {
    if (this.failure) return;
    this.failure = f;
    this.entries = [];
    this.bytes = 0;
  }
}

const g = globalThis as typeof globalThis & { __ttChangeRecorder?: AsyncLocalStorage<ChangeRecorder> };
const storage = (g.__ttChangeRecorder ??= new AsyncLocalStorage<ChangeRecorder>());

/** Modifica admin in corso nel contesto asincrono corrente (undefined fuori da withChangeset). */
export function currentChangeRecorder(): ChangeRecorder | undefined {
  return storage.getStore();
}

export function runWithRecorder<T>(rec: ChangeRecorder, fn: () => Promise<T>): Promise<T> {
  return storage.run(rec, fn);
}
