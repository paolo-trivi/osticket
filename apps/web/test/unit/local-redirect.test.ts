import { describe, expect, it } from "vitest";

import { localRedirect } from "@/server/http/redirect";

describe("localRedirect (route handler dietro reverse proxy)", () => {
  it("risponde 307 con Location relativa, senza l'host interno del container", () => {
    const res = localRedirect("/tickets/2");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/tickets/2");
  });

  it("conserva query e frammento", () => {
    expect(localRedirect("/login?error=link#access").headers.get("location")).toBe("/login?error=link#access");
  });

  it("rifiuta percorsi non interni", () => {
    for (const p of ["https://evil.example/", "//evil.example/", "tickets/2"]) expect(() => localRedirect(p)).toThrow();
  });
});
