import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ConfigNamespace } from "@/server/config/config";
import { assertWritableSchema, schemaStatus, SchemaNotVerifiedError, VERIFIED_SCHEMAS } from "@/server/system/schema-compat";

const cfgWith = (signature: string) => new ConfigNamespace("core", new Map([["schema_signature", signature]]), {});

describe("compatibilità con lo schema osTicket", () => {
  it("la firma di schema del codice osTicket in legacy/ è tra quelle verificate", () => {
    // Se un aggiornamento da osTicket upstream cambia lo schema, questo test fallisce: va verificata la
    // nuova versione con i test differenziali e aggiunta la firma a VERIFIED_SCHEMAS.
    const sig = readFileSync(fileURLToPath(new URL("../../../../legacy/include/upgrader/streams/core.sig", import.meta.url)), "utf8").trim();
    expect(VERIFIED_SCHEMAS.map((s) => s.signature)).toContain(sig);
  });

  it("schema verificato: scritture consentite", () => {
    const st = schemaStatus(cfgWith(VERIFIED_SCHEMAS[0].signature), {});
    expect(st).toMatchObject({ writable: true, override: false });
    expect(() => assertWritableSchema(cfgWith(VERIFIED_SCHEMAS[0].signature), {})).not.toThrow();
  });

  it("schema sconosciuto: sola lettura, salvo override esplicito", () => {
    expect(() => assertWritableSchema(cfgWith("0123456789abcdef0123456789abcdef"), {})).toThrow(SchemaNotVerifiedError);
    expect(schemaStatus(cfgWith("0123456789abcdef0123456789abcdef"), { TAILTICKET_ALLOW_UNVERIFIED_SCHEMA: "1" })).toMatchObject({
      writable: true,
      override: true,
      verified: null,
    });
  });
});
