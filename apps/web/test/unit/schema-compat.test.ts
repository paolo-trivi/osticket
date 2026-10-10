import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ConfigNamespace } from "@/server/config/config";
import { assertWritableSchema, KNOWN_SCHEMAS, knownSchema, schemaStatus, SchemaNotVerifiedError, schemaVersionLabel, VERIFIED_SCHEMAS } from "@/server/system/schema-compat";

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

describe("versioni di osTicket riconosciute dalla firma", () => {
  const V114 = "4bd47d94b10bd8a6bab35c119dadf41f";
  const V116 = "c37e165651dc289240fee7d244990ac1";
  const V117 = "83a22ba22b1a6a624fcb1da03882ac1b";
  const V118 = "5fb92bef17f3b603659e024c01cc7a59";

  it("firme delle release (core.sig dei tag upstream): una per serie, nessun doppione", () => {
    expect(knownSchema(V114)?.series).toBe("1.14");
    expect(knownSchema("add628927ee030469f5d3272ebda1e16")?.series).toBe("1.15");
    expect(knownSchema(V116)?.series).toBe("1.16");
    expect(knownSchema(V117)?.series).toBe("1.17");
    expect(knownSchema(V118)?.series).toBe("1.18");
    expect(new Set(KNOWN_SCHEMAS.map((s) => s.signature)).size).toBe(KNOWN_SCHEMAS.length);
    expect(KNOWN_SCHEMAS.every((s) => /^[0-9a-f]{32}$/.test(s.signature))).toBe(true);
    expect(knownSchema("0123456789abcdef0123456789abcdef")).toBeNull();
  });

  it("le firme verificate sono un sottoinsieme di quelle note, con la release del collaudo", () => {
    expect(VERIFIED_SCHEMAS).toContainEqual({ signature: V118, osticket: "1.18.x (verificato su 1.18.4)" });
    // harness differenziale completo sul codice e sullo schema di osTicket 1.17.8 (docs/compatibility.md)
    expect(VERIFIED_SCHEMAS).toContainEqual({ signature: V117, osticket: "1.17.x (verificato su 1.17.8)" });
    expect(schemaStatus(cfgWith(V117), {})).toMatchObject({ writable: true, override: false });
    for (const v of VERIFIED_SCHEMAS) expect(knownSchema(v.signature)?.verifiedOn).toBeTruthy();
  });

  it("etichetta per l'interfaccia: verificata, solo riconosciuta, sconosciuta", () => {
    expect(schemaVersionLabel(V118)).toBe("1.18.x (verificato su 1.18.4)");
    expect(schemaVersionLabel(V116)).toBe("1.16.x (non verificato)");
    expect(schemaVersionLabel("0123456789abcdef0123456789abcdef")).toBeNull();
    expect(schemaVersionLabel("")).toBeNull();
  });

  it("release nota ma non verificata: sola lettura, con la versione nello stato e nel messaggio d'errore", () => {
    expect(schemaStatus(cfgWith(V114), {})).toMatchObject({ known: { series: "1.14" }, verified: null, writable: false });
    expect(() => assertWritableSchema(cfgWith(V114), {})).toThrow(/osTicket 1\.14\)/);
    expect(schemaStatus(cfgWith("0123456789abcdef0123456789abcdef"), {}).known).toBeNull();
  });
});
