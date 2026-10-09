import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { performStaffLogin } from "@/server/auth/staff-auth";
import { closeDb } from "@/server/db";

import { compareWorkingDatabases, prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";

/** Imposta la stessa config su entrambi i DB di lavoro, tramite il PHP (come farebbe l'admin). */
async function setConfigBoth(namespace: string, values: Record<string, string | number>) {
  const { PHP_DB, TS_DB } = await import("./lib/harness");
  await runPhp({ op: "config.set", args: { namespace, values } }, PHP_DB);
  await runPhp({ op: "config.set", args: { namespace, values } }, TS_DB);
}

const IP = "10.1.2.3";

beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

describe("login agente: PHP vs TypeScript", () => {
  it("login riuscito con log di debug attivo: stesse righe in staff e syslog", async () => {
    await setConfigBoth("core", { log_level: 3 });
    const php = await runPhp({ op: "staff.login", args: { login: "devadmin", password: "Passw0rd!dev" }, ip: IP });
    const ts = await performStaffLogin({ login: "devadmin", password: "Passw0rd!dev", ip: IP });
    expect(php.ok).toBe(true);
    expect(ts.ok).toBe(true);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("login con email al posto dello username", async () => {
    const php = await runPhp({ op: "staff.login", args: { login: "admin@example.com", password: "Passw0rd!dev" }, ip: IP });
    const ts = await performStaffLogin({ login: "admin@example.com", password: "Passw0rd!dev", ip: IP });
    expect([php.ok, ts.ok]).toEqual([true, true]);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("password errata: nessuna scrittura da entrambe le parti", async () => {
    const php = await runPhp({ op: "staff.login", args: { login: "devadmin", password: "sbagliata" }, ip: IP });
    const ts = await performStaffLogin({ login: "devadmin", password: "sbagliata", ip: IP });
    expect([php.ok, ts.ok]).toEqual([false, false]);
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});
