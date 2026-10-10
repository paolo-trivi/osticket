import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { conflictLabel, entryKey, findConflicts, restoreOps, type CurrentRows } from "@/server/system/changes/plan";
import { listSummaries, loadChangeset, newChangeId, saveChangeset, updateSummary } from "@/server/system/changes/store";
import type { Changeset, ChangeEntry } from "@/server/system/changes/types";
import { decodeValue, encodeRow, encodeValue, looselyStored, UnsupportedValueError } from "@/server/system/changes/values";
import { restoreAllowed, writeAllowed } from "@/server/system/write-mode";

describe("valori dei changeset", () => {
  it("andata e ritorno in JSON: valori esatti, senza Date né fusi", () => {
    const row = {
      created: "2026-03-29 02:30:00",
      zero: "0000-00-00 00:00:00",
      none: null,
      price: "12345678901234567890.0001",
      big: "9223372036854775807",
      n: 42,
      f: 0.1,
      bin: Buffer.from([0, 1, 254, 255]),
      json: { a: [1, "x"] },
    };
    const back = JSON.parse(JSON.stringify(encodeRow(row))) as ReturnType<typeof encodeRow>;
    const decoded = Object.fromEntries(Object.entries(back).map(([k, v]) => [k, decodeValue(v)]));
    expect(decoded).toEqual({ ...row, json: '{"a":[1,"x"]}' });
    expect(Buffer.isBuffer(decoded.bin)).toBe(true);
    expect(encodeValue(10n, "c")).toBe("10");
    expect(encodeValue(true, "c")).toBe(1);
  });

  it("Date e numeri non finiti non sono serializzabili", () => {
    expect(() => encodeValue(new Date(), "created")).toThrow(UnsupportedValueError);
    expect(() => encodeValue(Number.NaN, "x")).toThrow(UnsupportedValueError);
  });

  it("confronto debole tra valore inserito e riletto", () => {
    expect(looselyStored("5", 5)).toBe(true);
    expect(looselyStored(true, 1)).toBe(true);
    expect(looselyStored(null, null)).toBe(true);
    expect(looselyStored("a", "b")).toBe(false);
    expect(looselyStored(null, "")).toBe(false);
  });
});

const T = "ost_config";
const upd = (id: number, before: string, after: string): ChangeEntry => ({ table: T, pk: { id }, before: { value: before }, after: { value: after } });
const current = (rows: Record<number, Record<string, string | number> | null>): CurrentRows => new Map(Object.entries(rows).map(([id, r]) => [entryKey(T, { id: Number(id) }), r]));

describe("piano dell'annullamento", () => {
  const entries: ChangeEntry[] = [
    { table: T, pk: { id: 9 }, before: null, after: { id: 9, key: "nuova", value: "1" } },
    upd(1, "a", "b"),
    upd(1, "b", "c"),
    { table: T, pk: { id: 5 }, before: { id: 5, key: "vecchia", value: "x" }, after: null },
  ];

  it("nessun conflitto se le righe sono come dopo la modifica (ultima voce per riga)", () => {
    expect(findConflicts(entries, current({ 9: { id: 9, key: "nuova", value: "1" }, 1: { id: 1, value: "c" }, 5: null }))).toEqual([]);
  });

  it("conflitti: riga cambiata dopo, riga inserita sparita, riga eliminata ricomparsa", () => {
    const c = findConflicts(entries, current({ 9: null, 1: { id: 1, value: "dal pannello classico" }, 5: { id: 5, key: "vecchia", value: "x" } }));
    expect(c.map((x) => [x.pk.id, x.kind])).toEqual([
      [9, "missing"],
      [1, "changed"],
      [5, "exists"],
    ]);
    expect(conflictLabel(c[1], "ost_")).toBe("config id=1");
  });

  it("operazioni in ordine inverso: eliminata → INSERT, modificata → UPDATE al primo valore, inserita → DELETE", () => {
    const { ops, skipped } = restoreOps(entries, current({ 9: { id: 9, key: "nuova", value: "1" }, 1: { id: 1, value: "c" }, 5: null }));
    expect(skipped).toBe(0);
    expect(ops).toEqual([
      { kind: "insert", table: T, row: { id: 5, key: "vecchia", value: "x" } },
      { kind: "update", table: T, pk: { id: 1 }, set: { value: "b" } },
      { kind: "update", table: T, pk: { id: 1 }, set: { value: "a" } },
      { kind: "delete", table: T, pk: { id: 9 } },
    ]);
  });

  it("con force: riga eliminata già ricomparsa → UPDATE; riga modificata sparita → saltata", () => {
    const { ops, skipped } = restoreOps([upd(1, "a", "b"), { table: T, pk: { id: 5 }, before: { id: 5, value: "x" }, after: null }], current({ 1: null, 5: { id: 5, value: "y" } }));
    expect(ops).toEqual([{ kind: "update", table: T, pk: { id: 5 }, set: { value: "x" } }]);
    expect(skipped).toBe(1);
  });
});

describe("modalità dell'annullamento (scope restore)", () => {
  it("consentito con modalità configurata full, anche se il doctor ha abbassato la modalità effettiva", () => {
    expect(restoreAllowed({ configured: "full", effective: "full", reasons: [] })).toBe(true);
    expect(restoreAllowed({ configured: "full", effective: "readonly", reasons: ["doctor:timezone"] })).toBe(true);
    expect(restoreAllowed({ configured: "full", effective: "readonly", reasons: ["doctor_failed"] })).toBe(true);
  });

  it("mai con lo schema non verificato o illeggibile, né con una modalità configurata diversa da full", () => {
    expect(restoreAllowed({ configured: "full", effective: "readonly", reasons: ["schema_unverified"] })).toBe(false);
    expect(restoreAllowed({ configured: "full", effective: "readonly", reasons: ["schema_unreadable", "doctor:timezone"] })).toBe(false);
    expect(restoreAllowed({ configured: "operational", effective: "operational", reasons: [] })).toBe(false);
    expect(restoreAllowed({ configured: "readonly", effective: "readonly", reasons: [] })).toBe(false);
    expect(writeAllowed("operational", "restore")).toBe(false);
  });
});

describe("archivio delle modifiche", () => {
  let dir: string;
  const saved = process.env.TAILTICKET_JOURNAL_DIR;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tt-changes-"));
    process.env.TAILTICKET_JOURNAL_DIR = dir;
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.TAILTICKET_JOURNAL_DIR;
    else process.env.TAILTICKET_JOURNAL_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  });

  const cs = (id: string, entries: ChangeEntry[] = [upd(1, "a", "b")]): Changeset => ({
    v: 1,
    id,
    ts: new Date().toISOString(),
    staff: { id: 1, username: "admin" },
    op: null,
    path: "/admin/settings/system",
    schema_signature: "sig",
    prefix: "ost_",
    undoable: true,
    touched: { ost_config: ["update"] },
    entries,
  });

  it("file 0600 in changes/, riepilogo senza valori, stato aggiornabile", async () => {
    const id = newChangeId();
    const summary = await saveChangeset(cs(id));
    expect(summary).toMatchObject({ id, rows: 1, tables: { ost_config: { insert: 0, update: 1, delete: 0 } } });
    expect(JSON.stringify(summary)).not.toContain('"value"');
    const st = await stat(join(dir, "changes", `${id}.json`));
    expect(st.mode & 0o777).toBe(0o600);
    expect((await loadChangeset(id))?.entries).toHaveLength(1);
    await updateSummary(id, (s) => ({ ...s, undone: { by: "x", ts: "t" } }));
    expect((await listSummaries())[0].undone).toEqual({ by: "x", ts: "t" });
    expect(await loadChangeset("../etc/passwd")).toBeNull();
  });

  it("conservazione: le modifiche più vecchie di 30 giorni si cancellano al salvataggio successivo", async () => {
    const old = newChangeId(new Date(Date.now() - 40 * 86_400_000));
    await saveChangeset(cs(old));
    await saveChangeset(cs(newChangeId()));
    const files = await readdir(join(dir, "changes"));
    expect(files.some((f) => f.startsWith(old))).toBe(false);
    expect(files.filter((f) => f.endsWith(".meta.json"))).toHaveLength(1);
  });
});
