import { describe, expect, it, vi } from "vitest";

import { UserAccountStatus } from "@/lib/osticket/flags";

/**
 * currentAgent/currentClient (usati da tutte le server action e route handler) sono null finché resta
 * il cambio password obbligatorio; sessionAgent/sessionClient (solo profilo e logout) no.
 */
const agentRow = { change_passwd: 1 };
vi.mock("@/server/auth/session", () => ({
  readSession: async (realm: string) => ({ realm, uid: 7, pwv: "", ip: "203.0.113.9", last: Math.floor(Date.now() / 1000), sid: "s", born: Math.floor(Date.now() / 1000) }),
  clientIp: async () => "203.0.113.9",
  writeSession: async () => undefined,
  clearSession: async () => undefined,
}));
vi.mock("@/server/config/config", () => ({ coreConfig: async () => ({ int: () => 0, bool: () => false, str: () => "" }) }));
vi.mock("@/server/db", () => ({ db: () => ({}), NOW: "NOW()" }));
vi.mock("@/server/db/time", () => ({ detectDbTimezone: async () => "UTC" }));
vi.mock("@/server/domain/staff/staff", () => ({
  findStaffIdForLogin: async () => null,
  loadAgent: async () => ({
    id: 7,
    isActive: true,
    row: { passwdreset: null },
    get mustChangePassword() {
      return !!agentRow.change_passwd;
    },
  }),
}));
const account = { status: UserAccountStatus.CONFIRMED | UserAccountStatus.REQUIRE_PASSWD_RESET, passwd: "x" };
vi.mock("@/server/domain/client/identity", () => ({
  loadClientIdentity: async () => ({ id: 7, account, guest: null }),
  accountIsActive: () => true,
  passwordVersion: () => "",
}));

// modalità di scrittura: scritture consentite, salvo nel test della sola lettura
const writes = { allowed: true };
vi.mock("@/server/system/write-mode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/system/write-mode")>()),
  canWrite: async () => writes.allowed,
}));

const { currentAgent, sessionAgent } = await import("@/server/auth/staff-auth");
const { currentClient, sessionClient, passwordChangePending } = await import("@/server/auth/client-auth");

describe("cambio password obbligatorio nelle sessioni", () => {
  it("agente con staff.change_passwd: currentAgent null, sessionAgent presente", async () => {
    expect(await sessionAgent()).toMatchObject({ id: 7 });
    expect(await currentAgent()).toBeNull();
  });

  it("cliente con REQUIRE_PASSWD_RESET: currentClient null, sessionClient presente", async () => {
    expect(await sessionClient()).toMatchObject({ id: 7 });
    expect(await currentClient()).toBeNull();
    expect(await passwordChangePending()).toBe(true);
  });

  it("sola lettura: il cambio password non è imposto (il form non potrebbe salvare)", async () => {
    writes.allowed = false;
    try {
      expect(await currentAgent()).toMatchObject({ id: 7 });
      expect(await currentClient()).toMatchObject({ id: 7 });
      expect(await passwordChangePending()).toBe(false);
    } finally {
      writes.allowed = true;
    }
  });
});
