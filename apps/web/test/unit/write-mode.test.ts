import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { journalEntry, journalFileName, journalFlushForTests, journalWrite } from "@/server/system/write-journal";
import { configuredWriteMode, currentWriteContext, readOnlyResult, withWriteScope, writeAllowed } from "@/server/system/write-mode";

describe("modalità di scrittura", () => {
  it("TAILTICKET_MODE assente vale full, un valore non valido readonly", () => {
    expect(configuredWriteMode({})).toBe("full");
    expect(configuredWriteMode({ TAILTICKET_MODE: "" })).toBe("full");
    expect(configuredWriteMode({ TAILTICKET_MODE: "operational" })).toBe("operational");
    expect(configuredWriteMode({ TAILTICKET_MODE: " ReadOnly " })).toBe("readonly");
    expect(configuredWriteMode({ TAILTICKET_MODE: "full" })).toBe("full");
    expect(configuredWriteMode({ TAILTICKET_MODE: "sola-lettura" })).toBe("readonly");
    expect(configuredWriteMode({ TAILTICKET_MODE: "1" })).toBe("readonly");
  });

  it("writeAllowed: full tutto, operational solo lo scope operational, readonly niente", () => {
    expect(writeAllowed("full", "operational")).toBe(true);
    expect(writeAllowed("full", "admin")).toBe(true);
    expect(writeAllowed("operational", "operational")).toBe(true);
    expect(writeAllowed("operational", "admin")).toBe(false);
    expect(writeAllowed("readonly", "operational")).toBe(false);
    expect(writeAllowed("readonly", "admin")).toBe(false);
  });

  it("esito read_only compatibile con SaveResult, MassResult e { error }", () => {
    const r = readOnlyResult();
    expect(r).toMatchObject({
      ok: false,
      error: "read_only",
      errors: { err: "read_only" },
      num: 0,
    });
    // oggetto nuovo a ogni chiamata (alcune action completano errors)
    expect(readOnlyResult()).not.toBe(r);
  });

  it("withWriteScope: lo scope interno vince, attore e operazione si ereditano", async () => {
    expect(currentWriteContext()).toBeUndefined();
    await withWriteScope(
      "admin",
      async () => {
        await withWriteScope("operational", async () => {
          expect(currentWriteContext()).toEqual({
            scope: "operational",
            op: "x",
            actor: { type: "agent", id: 1 },
          });
        });
        expect(currentWriteContext()?.scope).toBe("admin");
      },
      { op: "x", actor: { type: "agent", id: 1 } },
    );
  });
});

describe("registro delle scritture", () => {
  const prev = process.env.TAILTICKET_JOURNAL_DIR;
  let dir: string | undefined;
  afterEach(async () => {
    if (prev === undefined) delete process.env.TAILTICKET_JOURNAL_DIR;
    else process.env.TAILTICKET_JOURNAL_DIR = prev;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("riga sobria: niente valori, solo scope, attore, operazione e tabelle", () => {
    const now = new Date("2026-10-10T08:15:30.123Z");
    expect(journalEntry({ scope: "admin", actor: { type: "agent", id: 2 }, op: "admin.theme" }, { ost_config: ["insert", "update"] }, now)).toEqual({
      ts: "2026-10-10T08:15:30.123Z",
      scope: "admin",
      actor: { type: "agent", id: 2 },
      op: "admin.theme",
      tables: { ost_config: ["insert", "update"] },
    });
    expect(journalEntry(undefined, { ost_syslog: ["insert"] }, now)).toEqual({
      ts: now.toISOString(),
      scope: "none",
      tables: { ost_syslog: ["insert"] },
    });
    expect(journalFileName(now)).toBe("writes-2026-10-10.jsonl");
  });

  it("appende una riga JSON per operazione nel file del giorno", async () => {
    dir = await mkdtemp(join(tmpdir(), "tt-journal-"));
    process.env.TAILTICKET_JOURNAL_DIR = dir;
    journalWrite({ scope: "operational" }, { ost_lock: ["insert"] });
    journalWrite({ scope: "operational" }, { ost_lock: ["delete"] });
    await journalFlushForTests();
    const lines = (await readFile(join(dir, journalFileName(new Date())), "utf8")).trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).tables)).toEqual([{ ost_lock: ["insert"] }, { ost_lock: ["delete"] }]);
  });

  it("registro non scrivibile: nessun errore per l'operazione", async () => {
    process.env.TAILTICKET_JOURNAL_DIR = "/dev/null/non-esiste";
    expect(() => journalWrite({ scope: "admin" }, { ost_config: ["update"] })).not.toThrow();
    await expect(journalFlushForTests()).resolves.toBeUndefined();
  });
});
