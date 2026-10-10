/**
 * Controllo di APP_SESSION_SECRET (chiave dei cookie di sessione): chi la conosce può firmare una
 * sessione di qualunque agente, admin compreso. Si rifiutano i valori mancanti o corti, quelli di
 * esempio pubblicati nel repository (apps/web/.env.example, deploy/.env.example, build di CI e Docker)
 * e quelli a bassa entropia. Modulo senza dipendenze dal server: usato da env.ts e da instrumentation.ts
 * (controllo all'avvio).
 */
const MIN_LENGTH = 32;
const MIN_DISTINCT_CHARS = 10;

/** Frammenti dei segnaposto noti, confrontati senza maiuscole né punteggiatura. */
const PLACEHOLDERS = ["changeme", "cambiami", "example", "buildonly", "placeholder", "yoursecret", "insertsecret"];

/** Messaggio d'errore per un segreto non accettabile, o null se va bene. */
export function sessionSecretProblem(secret: string | undefined): string | null {
  if (!secret || secret.length < MIN_LENGTH) {
    return `APP_SESSION_SECRET mancante o più corto di ${MIN_LENGTH} caratteri: generarne uno con "openssl rand -base64 48"`;
  }
  const flat = secret.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (PLACEHOLDERS.some((p) => flat.includes(p))) {
    return 'APP_SESSION_SECRET è un valore di esempio (pubblico): generarne uno casuale con "openssl rand -base64 48"';
  }
  if (new Set(secret).size < MIN_DISTINCT_CHARS) {
    return 'APP_SESSION_SECRET ha troppo poca varietà di caratteri: generarne uno casuale con "openssl rand -base64 48"';
  }
  return null;
}

/** Controllo all'avvio (instrumentation.ts, solo runtime Node): con un segreto non valido il processo esce. */
export function exitOnBadSessionSecret(): void {
  const problem = sessionSecretProblem(process.env.APP_SESSION_SECRET);
  if (!problem) return;
  // un errore nel hook lascerebbe il server in piedi ma inutilizzabile: si esce, così il container fallisce
  console.error(`[tailticket] ${problem}`);
  process.exit(1);
}
