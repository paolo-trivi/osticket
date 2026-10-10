import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fsStoragePath, isStoredFileReadable } from "@/server/domain/file/storage";

describe("fsStoragePath (FilesystemStorage::getPath del plugin storage-fs)", () => {
  it("<uploadpath>/<prima lettera della chiave>/<chiave>", () => {
    expect(fsStoragePath("/srv/ost/att", "AbCdE1234567890_-xyz")).toBe(path.resolve("/srv/ost/att/A/AbCdE1234567890_-xyz"));
    expect(fsStoragePath("/srv/ost/att/", "-k")).toBe(path.resolve("/srv/ost/att/-/-k"));
    expect(fsStoragePath("/srv/ost/att", "_k")).toBe(path.resolve("/srv/ost/att/_/_k"));
  });

  it("rifiuta chiavi che uscirebbero dalla cartella (path traversal)", () => {
    for (const key of ["", ".", "..", "../etc", "..%2f", "a/../../etc/passwd", "a/b", "a\\b", "/etc/passwd", ".hidden", "a\0b", "x".repeat(200)]) {
      expect(fsStoragePath("/srv/ost/att", key), key).toBeNull();
    }
  });

  it("senza cartella configurata nessun percorso", () => {
    expect(fsStoragePath("", "abc")).toBeNull();
  });
});

describe("isStoredFileReadable", () => {
  let base: string;
  let outside: string;
  const prev = process.env.OST_ATTACHMENTS_DIR;

  beforeAll(() => {
    const root = mkdtempSync(path.join(tmpdir(), "tt-att-"));
    base = path.join(root, "upload");
    outside = path.join(root, "outside");
    mkdirSync(path.join(base, "k"), { recursive: true });
    mkdirSync(path.join(base, "s"), { recursive: true });
    mkdirSync(path.join(base, "d"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(base, "k", "key1"), "contenuto");
    writeFileSync(path.join(outside, "secret"), "fuori");
    // link simbolico che punta fuori dalla cartella degli allegati
    symlinkSync(path.join(outside, "secret"), path.join(base, "s", "symkey"));
    // una cartella con il nome della chiave non è un file
    mkdirSync(path.join(base, "d", "dirkey"));
    process.env.OST_ATTACHMENTS_DIR = base;
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.OST_ATTACHMENTS_DIR;
    else process.env.OST_ATTACHMENTS_DIR = prev;
    rmSync(path.dirname(base), { recursive: true, force: true });
  });

  it("backend D sempre leggibile, anche con bk vuoto", async () => {
    expect(await isStoredFileReadable({ bk: "D", key: "x" })).toBe(true);
    expect(await isStoredFileReadable({ bk: "", key: "x" })).toBe(true);
  });

  it("backend F: file presente nella cartella montata", async () => {
    expect(await isStoredFileReadable({ bk: "F", key: "key1" })).toBe(true);
    expect(await isStoredFileReadable({ bk: "F", key: "kmissing" })).toBe(false);
  });

  it("backend F: link simbolici verso l'esterno e cartelle rifiutati", async () => {
    expect(await isStoredFileReadable({ bk: "F", key: "symkey" })).toBe(false);
    expect(await isStoredFileReadable({ bk: "F", key: "dirkey" })).toBe(false);
  });

  it("backend F senza cartella configurata e altri backend: non leggibili", async () => {
    expect(await isStoredFileReadable({ bk: "S", key: "key1" })).toBe(false);
    expect(await isStoredFileReadable({ bk: "6", key: "key1" })).toBe(false);
    process.env.OST_ATTACHMENTS_DIR = "";
    try {
      expect(await isStoredFileReadable({ bk: "F", key: "key1" })).toBe(false);
    } finally {
      process.env.OST_ATTACHMENTS_DIR = base;
    }
  });
});
