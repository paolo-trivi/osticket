import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Token delle route interne usate dal CLI dall'interno del container (/api/doctor e /api/doctor/changes,
 * che il proxy non espone): header X-Doctor-Token confrontato a tempo costante con TAILTICKET_DOCTOR_TOKEN
 * (obbligatoria, almeno 24 caratteri).
 */
const MIN_TOKEN_LENGTH = 24;

/** Confronto a tempo costante (sugli hash: lunghezze diverse non escono prima). */
function tokenMatches(given: string | null, expected: string): boolean {
  const a = createHash("sha256")
    .update(given ?? "", "utf8")
    .digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b) && given !== null;
}

export function internalTokenOk(request: Request, env: Record<string, string | undefined> = process.env): boolean {
  const expected = env.TAILTICKET_DOCTOR_TOKEN ?? "";
  return expected.length >= MIN_TOKEN_LENGTH && tokenMatches(request.headers.get("x-doctor-token"), expected);
}
