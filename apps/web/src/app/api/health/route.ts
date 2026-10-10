import { sql } from "kysely";
import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { cachedEffectiveWriteMode } from "@/server/system/write-mode";

/**
 * Stato di salute pubblico (HEALTHCHECK del container, monitoraggio): nessun segreto né dettaglio
 * interno, solo la modalità di scrittura e lo stato dello schema.
 *   200 { status: "ok" | "degraded", mode, configuredMode, schema: "verified" | "unverified" }
 * "degraded" se la modalità effettiva è stata abbassata (schema non verificato, problemi del doctor):
 * l'app è comunque funzionante in consultazione. 503 solo se il DB non risponde.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    await sql`SELECT 1`.execute(db());
  } catch {
    return NextResponse.json({ status: "degraded", db: "unreachable" }, { status: 503, headers: NO_STORE });
  }
  const m = await cachedEffectiveWriteMode();
  const schemaOk = !m.reasons.some((r) => r === "schema_unverified" || r === "schema_unreadable");
  return NextResponse.json(
    {
      status: m.reasons.length ? "degraded" : "ok",
      mode: m.effective,
      configuredMode: m.configured,
      schema: schemaOk ? "verified" : "unverified",
    },
    { headers: NO_STORE },
  );
}
