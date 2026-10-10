import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CHANGE_ID_RE } from "@/lib/changes";

import { entryKind, type Changeset, type ChangeSummary, type TableCounts } from "./types";

/**
 * Archivio delle modifiche admin: `<TAILTICKET_JOURNAL_DIR>/changes/<id>.json` (changeset completo, con i
 * valori delle righe: hash delle password, credenziali cifrate… mai esposto via HTTP) e `<id>.meta.json`
 * (riepilogo senza valori, per elenco, interfaccia e CLI). Cartella 0700, file 0600, scrittura atomica
 * (file temporaneo + rename). Conservazione: le modifiche degli ultimi RETENTION_DAYS giorni, al massimo
 * RETENTION_MAX (le più vecchie si cancellano a ogni nuovo salvataggio).
 */
const JOURNAL_ENV = "TAILTICKET_JOURNAL_DIR";
const RETENTION_DAYS = 30;
const RETENTION_MAX = 200;

function changesDir(env: Record<string, string | undefined> = process.env): string | null {
  const dir = env[JOURNAL_ENV]?.trim();
  return dir ? join(dir, "changes") : null;
}

/** Registrazione delle modifiche attiva (TAILTICKET_JOURNAL_DIR impostata). */
export function changesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return changesDir(env) !== null;
}

/** YYYYMMDD-HHMMSS (UTC): inizio degli id, confrontabile come stringa. */
function stamp(d: Date): string {
  const s = d.toISOString();
  return `${s.slice(0, 4)}${s.slice(5, 7)}${s.slice(8, 10)}-${s.slice(11, 13)}${s.slice(14, 16)}${s.slice(17, 19)}`;
}

/** Id ordinabile per data: YYYYMMDD-HHMMSS-xxxx (UTC). */
export function newChangeId(now = new Date()): string {
  return `${stamp(now)}-${randomBytes(2).toString("hex")}`;
}

function summarize(cs: Changeset): ChangeSummary {
  const tables: Record<string, TableCounts> = {};
  for (const e of cs.entries) (tables[e.table] ??= { insert: 0, update: 0, delete: 0 })[entryKind(e)]++;
  const { entries, v, ...head } = cs;
  void v;
  return { ...head, rows: entries.length, tables };
}

function dirOrThrow(): string {
  const dir = changesDir();
  if (!dir) throw new Error(`${JOURNAL_ENV} non impostata`);
  return dir;
}

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
}

export async function saveChangeset(cs: Changeset): Promise<ChangeSummary> {
  const dir = dirOrThrow();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const summary = summarize(cs);
  await writeAtomic(join(dir, `${cs.id}.json`), JSON.stringify(cs));
  await writeAtomic(join(dir, `${cs.id}.meta.json`), JSON.stringify(summary));
  await prune(dir).catch((err: unknown) => console.error("[changes] pulizia dell'archivio non riuscita", err));
  return summary;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function loadChangeset(id: string): Promise<Changeset | null> {
  const dir = changesDir();
  if (!dir || !CHANGE_ID_RE.test(id)) return null;
  return readJson<Changeset>(join(dir, `${id}.json`));
}

export async function loadSummary(id: string): Promise<ChangeSummary | null> {
  const dir = changesDir();
  if (!dir || !CHANGE_ID_RE.test(id)) return null;
  return readJson<ChangeSummary>(join(dir, `${id}.meta.json`));
}

async function summaryIds(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names
    .filter((n) => n.endsWith(".meta.json"))
    .map((n) => n.slice(0, -".meta.json".length))
    .filter((id) => CHANGE_ID_RE.test(id))
    .sort()
    .reverse();
}

/** Riepiloghi, dal più recente. */
export async function listSummaries(): Promise<ChangeSummary[]> {
  const dir = changesDir();
  if (!dir) return [];
  const out: ChangeSummary[] = [];
  for (const id of await summaryIds(dir)) {
    const s = await readJson<ChangeSummary>(join(dir, `${id}.meta.json`)).catch(() => null);
    if (s) out.push(s);
  }
  return out;
}

/** Aggiorna lo stato nel riepilogo (annullata / di nuovo annullabile). */
export async function updateSummary(id: string, patch: (s: ChangeSummary) => ChangeSummary): Promise<void> {
  const s = await loadSummary(id);
  if (s) await writeAtomic(join(dirOrThrow(), `${id}.meta.json`), JSON.stringify(patch(s)));
}

async function prune(dir: string, now = Date.now()): Promise<void> {
  const ids = await summaryIds(dir);
  const minId = stamp(new Date(now - RETENTION_DAYS * 86_400_000));
  for (const [i, id] of ids.entries()) {
    if (i < RETENTION_MAX && id >= minId) continue;
    for (const f of [`${id}.json`, `${id}.meta.json`]) await unlink(join(dir, f)).catch(() => {});
  }
}
