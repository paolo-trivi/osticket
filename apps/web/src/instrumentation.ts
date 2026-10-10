/**
 * Avvio del server: APP_SESSION_SECRET mancante, debole o di esempio blocca la partenza con un messaggio
 * chiaro, invece di fallire alla prima richiesta (o, peggio, di firmare sessioni con un valore pubblico).
 * Durante `next build` non si controlla: la build usa un valore fittizio e non firma sessioni.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { exitOnBadSessionSecret } = await import("./server/session-secret");
    exitOnBadSessionSecret();
  }
}
