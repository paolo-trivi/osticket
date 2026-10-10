import { NextResponse } from "next/server";

import { runDoctor } from "@/server/system/doctor";
import { formatReportText } from "@/server/system/doctor/format";
import { isWritable } from "@/server/system/doctor/types";
import { internalTokenOk } from "@/server/system/internal-token";

/**
 * Diagnostica del collegamento a osTicket per il CLI di installazione:
 *   GET /api/doctor               → JSON { writable, summary, checks }
 *   GET /api/doctor?format=text   → tabella di testo da stampare così com'è
 * Protetta dall'header X-Doctor-Token, confrontato a tempo costante con TAILTICKET_DOCTOR_TOKEN
 * (obbligatoria, almeno 24 caratteri). Token assente, corto o sbagliato: 404, come se la route non
 * esistesse. Lo stato è 200 anche con blocchi: l'esito è nel contenuto (writable).
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  if (!internalTokenOk(request)) return new NextResponse(null, { status: 404, headers: NO_STORE });
  const report = await runDoctor();
  if (new URL(request.url).searchParams.get("format") === "text") {
    return new NextResponse(formatReportText(report), {
      headers: {
        ...NO_STORE,
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return NextResponse.json({ writable: isWritable(report), ...report }, { headers: NO_STORE });
}
