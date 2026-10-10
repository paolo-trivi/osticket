import { notFound } from "next/navigation";
import { describe, expect, it, vi } from "vitest";

import { tryAction } from "@/lib/try-action";

describe("tryAction (server action chiamate dai componenti client)", () => {
  it("restituisce il valore se la chiamata riesce", async () => {
    await expect(tryAction(async () => 42)).resolves.toEqual({ ok: true, value: 42 });
  });

  it("un errore diventa { ok: false } invece di arrivare all'error boundary", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(tryAction(async () => Promise.reject(new Error("Failed to fetch")))).resolves.toEqual({ ok: false });
    spy.mockRestore();
  });

  it("notFound/redirect di Next passano invariati", async () => {
    await expect(tryAction(async () => notFound())).rejects.toThrow();
  });
});
