import "server-only";

import type { ConfigNamespace } from "../config/config";

/**
 * Compatibilità con lo schema del database osTicket.
 *
 * osTicket registra in `config` (namespace `core`, chiave `schema_signature`) la firma dell'ultima
 * patch di schema applicata dall'upgrader (legacy/include/upgrader/streams/core.sig). TailTicket
 * scrive sul DB riproducendo le righe del PHP di una versione precisa: se il DB è stato aggiornato a
 * uno schema che TailTicket non ha ancora verificato con i test differenziali, le scritture vengono
 * rifiutate (sola lettura) finché la nuova firma non è aggiunta qui dopo la verifica.
 */
export interface VerifiedSchema {
  signature: string;
  osticket: string;
}

/** Firme di schema verificate con l'harness differenziale (la più recente in fondo). */
export const VERIFIED_SCHEMAS: readonly VerifiedSchema[] = [{ signature: "5fb92bef17f3b603659e024c01cc7a59", osticket: "1.18.x (verificato su 1.18.4)" }];

/** Variabile d'ambiente per forzare le scritture su uno schema non verificato (sconsigliato). */
export const ALLOW_UNVERIFIED_ENV = "TAILTICKET_ALLOW_UNVERIFIED_SCHEMA";

export interface SchemaStatus {
  signature: string;
  verified: VerifiedSchema | null;
  /** scritture consentite: schema verificato oppure override esplicito */
  writable: boolean;
  override: boolean;
}

export function schemaStatus(cfg: ConfigNamespace, env: Record<string, string | undefined> = process.env): SchemaStatus {
  const signature = cfg.str("schema_signature");
  const verified = VERIFIED_SCHEMAS.find((s) => s.signature === signature) ?? null;
  const override = env[ALLOW_UNVERIFIED_ENV] === "1";
  return { signature, verified, writable: !!verified || override, override: !verified && override };
}

export class SchemaNotVerifiedError extends Error {
  constructor(readonly signature: string) {
    super(
      `Schema del database osTicket non verificato da TailTicket (schema_signature ${signature || "assente"}): ` +
        `scritture disabilitate. Verificare la nuova versione con i test differenziali e aggiungerla a VERIFIED_SCHEMAS, ` +
        `oppure impostare ${ALLOW_UNVERIFIED_ENV}=1 a proprio rischio.`,
    );
    this.name = "SchemaNotVerifiedError";
  }
}

/** Da chiamare prima di ogni scrittura: rifiuta gli schemi non verificati. */
export function assertWritableSchema(cfg: ConfigNamespace, env: Record<string, string | undefined> = process.env): void {
  const status = schemaStatus(cfg, env);
  if (!status.writable) throw new SchemaNotVerifiedError(status.signature);
}
