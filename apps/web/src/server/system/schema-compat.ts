import "server-only";

import type { ConfigNamespace } from "../config/config";

/**
 * Compatibilità con lo schema del database osTicket.
 *
 * osTicket registra in `config` (namespace `core`, chiave `schema_signature`) la firma dell'ultima
 * patch di schema applicata dall'upgrader (legacy/include/upgrader/streams/core.sig). TailTicket
 * scrive sul DB riproducendo le righe del PHP di una versione precisa: se il DB è stato aggiornato a
 * uno schema che TailTicket non ha ancora verificato con i test differenziali, le scritture vengono
 * rifiutate (sola lettura) finché la nuova firma non è verificata (verifiedOn in KNOWN_SCHEMAS).
 */
interface KnownSchema {
  signature: string;
  /** serie di osTicket: tutte le patch di una serie condividono la firma (es. 1.17.0 … 1.17.8) */
  series: string;
  /** release su cui l'harness differenziale è passato per intero; assente = firma solo riconosciuta */
  verifiedOn?: string;
}

/**
 * Firme di schema delle release osTicket (include/upgrader/streams/core.sig dei tag upstream, dalla più
 * vecchia). Le firme intermedie dell'upgrader (aggiornamento non completato) e quelle delle RC non ci sono.
 */
export const KNOWN_SCHEMAS: readonly KnownSchema[] = [
  { signature: "98ad7d550c26ac44340350912296e673", series: "1.10" },
  { signature: "00c949a623b82848baaf3480b51307e3", series: "1.11/1.12" },
  { signature: "4bd47d94b10bd8a6bab35c119dadf41f", series: "1.14" },
  { signature: "add628927ee030469f5d3272ebda1e16", series: "1.15" },
  { signature: "c37e165651dc289240fee7d244990ac1", series: "1.16" },
  // 1.17.8 e 1.18.4 (rilasciate insieme) differiscono solo per plugin.name (VARCHAR 255, 83a22ba2-5fb92bef.patch.sql) e OAuth2: docs/compatibility.md
  { signature: "83a22ba22b1a6a624fcb1da03882ac1b", series: "1.17", verifiedOn: "1.17.8" },
  { signature: "5fb92bef17f3b603659e024c01cc7a59", series: "1.18", verifiedOn: "1.18.4" },
];

interface VerifiedSchema {
  signature: string;
  osticket: string;
}

/** Firme di schema verificate con l'harness differenziale (la più recente in fondo). */
export const VERIFIED_SCHEMAS: readonly VerifiedSchema[] = KNOWN_SCHEMAS.filter((s) => s.verifiedOn).map((s) => ({
  signature: s.signature,
  osticket: `${s.series}.x (verificato su ${s.verifiedOn})`,
}));

/** Release osTicket della firma, oppure null se la firma non è di una release nota. */
export function knownSchema(signature: string): KnownSchema | null {
  return KNOWN_SCHEMAS.find((s) => s.signature === signature) ?? null;
}

/** Versione di osTicket ricavata dalla firma, per l'interfaccia: "1.18.x (verificato su 1.18.4)", "1.16.x (non verificato)" o null. */
export function schemaVersionLabel(signature: string): string | null {
  const known = knownSchema(signature);
  if (!known) return null;
  return VERIFIED_SCHEMAS.find((v) => v.signature === signature)?.osticket ?? `${known.series}.x (non verificato)`;
}

/** Variabile d'ambiente per forzare le scritture su uno schema non verificato (sconsigliato). */
const ALLOW_UNVERIFIED_ENV = "TAILTICKET_ALLOW_UNVERIFIED_SCHEMA";

export interface SchemaStatus {
  signature: string;
  /** release osTicket riconosciuta dalla firma, anche se non verificata */
  known: KnownSchema | null;
  verified: VerifiedSchema | null;
  /** scritture consentite: schema verificato oppure override esplicito */
  writable: boolean;
  override: boolean;
}

export function schemaStatus(cfg: ConfigNamespace, env: Record<string, string | undefined> = process.env): SchemaStatus {
  const signature = cfg.str("schema_signature");
  const verified = VERIFIED_SCHEMAS.find((s) => s.signature === signature) ?? null;
  const override = env[ALLOW_UNVERIFIED_ENV] === "1";
  return { signature, known: knownSchema(signature), verified, writable: !!verified || override, override: !verified && override };
}

export class SchemaNotVerifiedError extends Error {
  constructor(readonly signature: string) {
    const known = knownSchema(signature);
    super(
      `Schema del database osTicket non verificato da TailTicket (schema_signature ${signature || "assente"}` +
        `${known ? `, osTicket ${known.series}` : ""}): scritture disabilitate. Verificare la versione con i test differenziali ` +
        `e segnarla come verificata in KNOWN_SCHEMAS, oppure impostare ${ALLOW_UNVERIFIED_ENV}=1 a proprio rischio.`,
    );
    this.name = "SchemaNotVerifiedError";
  }
}

/** Da chiamare prima di ogni scrittura: rifiuta gli schemi non verificati. */
export function assertWritableSchema(cfg: ConfigNamespace, env: Record<string, string | undefined> = process.env): void {
  const status = schemaStatus(cfg, env);
  if (!status.writable) throw new SchemaNotVerifiedError(status.signature);
}
