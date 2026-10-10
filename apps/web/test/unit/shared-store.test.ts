import { describe, expect, it, vi } from "vitest";

/**
 * Stato di sicurezza in memoria condiviso dal processo (bounded-store.ts). Il bug del collaudo RC: il
 * bundle delle route /api e quello delle pagine avevano due copie di revocation.ts, quindi il logout non
 * revocava la sessione sulle API. vi.resetModules() ricrea la stessa situazione: due istanze dei moduli.
 */
async function freshModules() {
  vi.resetModules();
  const store = await import("@/server/auth/bounded-store");
  const revocation = await import("@/server/auth/revocation");
  const strikes = await import("@/server/auth/strikes");
  return { store, revocation, strikes };
}

describe("registro globale degli store in memoria", () => {
  it("due copie del modulo condividono la stessa istanza per nome", async () => {
    const a = await freshModules();
    const b = await freshModules();
    // i moduli sono davvero duplicati (classi diverse)...
    expect(a.store.BoundedStore).not.toBe(b.store.BoundedStore);
    // ...ma lo store registrato su globalThis è uno solo
    expect(a.store.sharedStore("test.same", 10)).toBe(b.store.sharedStore("test.same", 10));
    expect(a.store.sharedStore("test.same", 10)).not.toBe(a.store.sharedStore("test.other", 10));
  });

  it("una sessione revocata da un bundle è revocata anche nell'altro", async () => {
    const pages = await freshModules();
    const api = await freshModules();
    expect(api.revocation.isSessionRevoked("sid-rc-1")).toBe(false);
    pages.revocation.revokeSession("sid-rc-1", Date.now() / 1000 + 3600);
    expect(api.revocation.isSessionRevoked("sid-rc-1")).toBe(true);
  });

  it("i tentativi falliti si sommano tra i bundle", async () => {
    const a = await freshModules();
    const b = await freshModules();
    a.strikes.addStrike("staff", "198.51.100.9", "rc", 5);
    expect(b.strikes.addStrike("staff", "198.51.100.9", "rc", 5).strikes).toBe(2);
    b.strikes.resetStrikes("staff", "198.51.100.9", "rc");
  });
});
