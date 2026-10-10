import { describe, expect, it } from "vitest";

import { idOrNotFound, parseId } from "@/lib/route-id";

describe("parseId (segmenti dinamici [id])", () => {
  it("accetta solo interi positivi in cifre decimali", () => {
    expect(parseId("1")).toBe(1);
    expect(parseId("42")).toBe(42);
    expect(parseId("4294967295")).toBe(4294967295);
  });

  it("rifiuta valori che diventerebbero NaN o id inesistenti nelle query", () => {
    for (const raw of ["abc", "", "0", "007", "-3", "1.5", "1e3", " 1", "0x10", "12abc", "99999999999999999", undefined, null]) {
      expect(parseId(raw)).toBeNull();
    }
  });

  it("idOrNotFound: id malformato → notFound() di Next", () => {
    expect(idOrNotFound("7")).toBe(7);
    expect(() => idOrNotFound("abc")).toThrow();
  });
});
