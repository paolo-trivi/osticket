import { describe, expect, it } from "vitest";

import { isAgentPath, isPortalPath, safeRedirectPath } from "@/server/actions/redirect-path";
import { BoundedStore } from "@/server/auth/bounded-store";
import { resolveClientIp, trustedProxyHops } from "@/server/auth/client-ip";
import { sessionSecretProblem } from "@/server/session-secret";

const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });

describe("resolveClientIp (header del reverse proxy)", () => {
  it("preferisce X-Real-IP impostato dal proxy", () => {
    expect(resolveClientIp(headers({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4, 203.0.113.7" }), 1)).toBe("203.0.113.7");
  });

  it("senza X-Real-IP usa il valore più a destra di X-Forwarded-For (non quello scelto dal client)", () => {
    expect(resolveClientIp(headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }), 1)).toBe("203.0.113.7");
    expect(resolveClientIp(headers({ "x-forwarded-for": " 203.0.113.7 " }), 1)).toBe("203.0.113.7");
  });

  it("con N proxy fidati prende l'N-esimo valore da destra", () => {
    expect(resolveClientIp(headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.0.0.2" }), 2)).toBe("203.0.113.7");
    // meno valori dei proxy dichiarati: il più a sinistra
    expect(resolveClientIp(headers({ "x-forwarded-for": "203.0.113.7" }), 3)).toBe("203.0.113.7");
  });

  it("0 proxy fidati, header assenti o valori non validi: IP sconosciuto", () => {
    expect(resolveClientIp(headers({ "x-real-ip": "203.0.113.7" }), 0)).toBe("0.0.0.0");
    expect(resolveClientIp(headers({}), 1)).toBe("0.0.0.0");
    expect(resolveClientIp(headers({ "x-real-ip": "<script>" }), 1)).toBe("0.0.0.0");
    expect(resolveClientIp(headers({ "x-forwarded-for": "1.2.3.4, evil" }), 1)).toBe("0.0.0.0");
  });

  it("IPv6", () => {
    expect(resolveClientIp(headers({ "x-real-ip": "2001:db8::1" }), 1)).toBe("2001:db8::1");
  });

  it("TAILTICKET_TRUSTED_PROXY_HOPS: default 1, interi >= 0", () => {
    expect(trustedProxyHops({})).toBe(1);
    expect(trustedProxyHops({ TAILTICKET_TRUSTED_PROXY_HOPS: "2" })).toBe(2);
    expect(trustedProxyHops({ TAILTICKET_TRUSTED_PROXY_HOPS: "0" })).toBe(0);
    expect(trustedProxyHops({ TAILTICKET_TRUSTED_PROXY_HOPS: "x" })).toBe(1);
  });
});

describe("safeRedirectPath (niente open redirect)", () => {
  it("accetta percorsi relativi interni, normalizzati", () => {
    expect(safeRedirectPath("/tickets/5?x=1#r", "/f")).toBe("/tickets/5?x=1#r");
    expect(safeRedirectPath("/kb/../tickets", "/f")).toBe("/tickets");
  });

  it.each([
    "//evil.com",
    "/\\evil.com",
    "/%5Cevil.com",
    "/\tevil.com",
    "/%09/evil.com".replace("%09", "\t"),
    "\\\\evil.com",
    "https://evil.com",
    "evil.com",
    "/a/..//evil.com",
    "",
  ])("rifiuta %j", (next) => {
    expect(safeRedirectPath(next, "/fallback")).toBe("/fallback");
  });

  it("rifiuta valori non stringa", () => {
    expect(safeRedirectPath(null, "/f")).toBe("/f");
  });

  it("filtri del pannello agenti e del portale", () => {
    expect(safeRedirectPath("/agent/tickets/1", "/agent", isAgentPath)).toBe("/agent/tickets/1");
    expect(safeRedirectPath("/agentx", "/agent", isAgentPath)).toBe("/agent");
    expect(safeRedirectPath("/tickets", "/agent", isAgentPath)).toBe("/agent");
    expect(safeRedirectPath("/tickets/3", "/tickets", isPortalPath)).toBe("/tickets/3");
    expect(safeRedirectPath("/admin/settings", "/tickets", isPortalPath)).toBe("/tickets");
    expect(safeRedirectPath("/kb/../agent", "/tickets", isPortalPath)).toBe("/tickets");
  });
});

describe("sessionSecretProblem (APP_SESSION_SECRET)", () => {
  it("rifiuta valori mancanti, corti, di esempio o poco vari", () => {
    expect(sessionSecretProblem(undefined)).toMatch(/mancante/);
    expect(sessionSecretProblem("abc")).toMatch(/32/);
    // apps/web/.env.example storico, deploy/.env.example, build di CI e Docker
    expect(sessionSecretProblem("cambiami-cambiami-cambiami-cambiami-0000")).toMatch(/esempio/);
    expect(sessionSecretProblem("CHANGE_ME_CHANGE_ME_CHANGE_ME_CHANGE_ME_1")).toMatch(/esempio/);
    expect(sessionSecretProblem("build-only-build-only-build-only-0123")).toMatch(/esempio/);
    expect(sessionSecretProblem("my-example-secret-for-the-session-cookies")).toMatch(/esempio/);
    expect(sessionSecretProblem("a".repeat(40))).toMatch(/varietà/);
  });

  it("accetta un segreto casuale", () => {
    expect(sessionSecretProblem("q8V2nX0rLw5tYbZc3Hk9Jm1Pd7Sg4Fa6EuRi0OyTq2N")).toBeNull();
  });
});

describe("BoundedStore (stato di sicurezza in memoria)", () => {
  it("le voci scadute non si leggono", () => {
    const s = new BoundedStore<number>(10);
    s.set("a", 1, 100, 50);
    expect(s.get("a", 99)).toBe(1);
    expect(s.get("a", 100)).toBeUndefined();
    expect(s.size).toBe(0);
  });

  it("tetto massimo: si scartano le voci inserite per prime", () => {
    const s = new BoundedStore<number>(3);
    for (let i = 0; i < 5; i++) s.set(`k${i}`, i, 1000, 0);
    expect(s.size).toBe(3);
    expect(s.get("k0", 1)).toBeUndefined();
    expect(s.get("k4", 1)).toBe(4);
  });

  it("pulizia periodica delle voci scadute", () => {
    const s = new BoundedStore<number>(100_000);
    for (let i = 0; i < 255; i++) s.set(`old${i}`, i, 10, 0);
    s.set("new", 1, 1000, 20);
    expect(s.size).toBe(1);
  });
});
