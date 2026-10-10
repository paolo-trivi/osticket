import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Sessioni e guardie senza DB: cookie e header di Next simulati, agente/cliente della sessione simulati.
 *  - logout = sessione revocata sul server (il cookie copiato prima non vale più);
 *  - durata massima assoluta anche senza timeout di inattività;
 *  - cambio password obbligatorio: solo profilo e logout (scp/staff.inc.php, client.inc.php).
 */
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => new Headers({ "x-real-ip": "203.0.113.9" }),
}));

class Redirect extends Error {
  constructor(public href: string) {
    super(href);
  }
}
vi.mock("@/i18n/navigation", () => ({
  redirect: ({ href }: { href: string }) => {
    throw new Redirect(href);
  },
}));

const state: { agent: { mustChangePassword: boolean; isAdmin?: boolean } | null; client: object | null; clientMust: boolean } = {
  agent: null,
  client: null,
  clientMust: false,
};
vi.mock("@/server/auth/staff-auth", () => ({
  sessionAgent: async () => state.agent,
  currentAgent: async () => (state.agent && !state.agent.mustChangePassword ? state.agent : null),
}));
vi.mock("@/server/auth/client-auth", () => ({
  sessionClient: async () => state.client,
  currentClient: async () => (state.client && !state.clientMust ? state.client : null),
  clientMustChangePassword: () => state.clientMust,
}));

const { clearSession, clientIp, MAX_SESSION_HOURS, readSession, writeSession } = await import("@/server/auth/session");
const { requireAgent } = await import("@/app/[locale]/(staff)/agent/guard");
const { portalVisitor, requireClient } = await import("@/app/[locale]/(client)/guard");

const base = { realm: "staff" as const, uid: 7, pwv: "", ip: "203.0.113.9", last: Math.floor(Date.now() / 1000) };

async function redirectOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    if (e instanceof Redirect) return e.href;
    throw e;
  }
}

describe("sessione: id, revoca al logout, durata massima", () => {
  beforeEach(() => jar.clear());

  it("l'IP della richiesta viene da X-Real-IP del proxy", async () => {
    expect(await clientIp()).toBe("203.0.113.9");
  });

  it("nuova sessione con id casuale; le riscritture lo conservano", async () => {
    await writeSession(base);
    const s = await readSession("staff");
    expect(s?.sid).toMatch(/^[\w-]{20,}$/);
    await writeSession({ ...s!, last: s!.last + 5 });
    expect((await readSession("staff"))?.sid).toBe(s!.sid);
  });

  it("dopo il logout il cookie copiato non è più valido", async () => {
    await writeSession(base);
    const stolen = jar.get("ostn_staff")!;
    await clearSession("staff");
    expect(jar.has("ostn_staff")).toBe(false);
    jar.set("ostn_staff", stolen);
    expect(await readSession("staff")).toBeNull();
  });

  it("il logout di una sessione non tocca le altre", async () => {
    await writeSession(base);
    const other = jar.get("ostn_staff")!;
    await writeSession(base);
    await clearSession("staff");
    jar.set("ostn_staff", other);
    expect((await readSession("staff"))?.uid).toBe(7);
  });

  it(`durata massima assoluta di ${MAX_SESSION_HOURS} ore dal login, anche se rinnovata`, async () => {
    const now = Math.floor(Date.now() / 1000);
    await writeSession({ ...base, born: now - MAX_SESSION_HOURS * 3600 + 60, sid: "sessione-quasi-scaduta" });
    expect(await readSession("staff")).not.toBeNull();
    await writeSession({ ...base, last: now, born: now - MAX_SESSION_HOURS * 3600 - 1, sid: "sessione-scaduta" });
    expect(await readSession("staff")).toBeNull();
  });

  it("token senza id di sessione (formato precedente) rifiutato", async () => {
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({ ...base }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(process.env.APP_SESSION_SECRET));
    jar.set("ostn_staff", token);
    expect(await readSession("staff")).toBeNull();
  });
});

describe("guardie: cambio password obbligatorio", () => {
  beforeEach(() => {
    state.agent = null;
    state.client = null;
    state.clientMust = false;
  });

  it("agente senza sessione → login", async () => {
    expect(await redirectOf(requireAgent("it"))).toBe("/agent/login?expired=1");
  });

  it("agente con change_passwd: ogni pagina rimanda al profilo, il profilo è ammesso", async () => {
    state.agent = { mustChangePassword: true };
    expect(await redirectOf(requireAgent("it"))).toBe("/agent/profile?pwchange=1");
    expect(await redirectOf(requireAgent("it", { passwordChange: true }))).toBeNull();
  });

  it("agente senza obbligo: nessun redirect", async () => {
    state.agent = { mustChangePassword: false };
    expect(await requireAgent("it")).toBe(state.agent);
  });

  it("cliente con REQUIRE_PASSWD_RESET: pagine protette e pubbliche rimandano al profilo", async () => {
    state.client = { id: 3 };
    state.clientMust = true;
    expect(await redirectOf(requireClient("it", "/tickets"))).toBe("/profile?pwchange=1");
    expect(await redirectOf(portalVisitor("it"))).toBe("/profile?pwchange=1");
    expect(await redirectOf(requireClient("it", "/profile", { skipPwCheck: true }))).toBeNull();
  });

  it("cliente senza obbligo e visitatore anonimo", async () => {
    expect(await portalVisitor("it")).toBeNull();
    expect(await redirectOf(requireClient("it", "/tickets"))).toBe("/login?next=%2Ftickets");
    state.client = { id: 3 };
    expect(await portalVisitor("it")).toBe(state.client);
  });
});
