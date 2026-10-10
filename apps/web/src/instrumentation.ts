/**
 * Avvio del server: APP_SESSION_SECRET mancante, debole o di esempio blocca la partenza con un messaggio
 * chiaro, invece di fallire alla prima richiesta (o, peggio, di firmare sessioni con un valore pubblico).
 * Lo stesso per la configurazione di installazione (env.ts: ost-config.php e variabili in conflitto).
 * Poi una riga di log con la modalità di scrittura configurata ed effettiva (write-mode.ts), senza
 * segreti; il calcolo non ritarda l'avvio (il DB potrebbe non essere ancora pronto).
 * Durante `next build` non si controlla: la build usa un valore fittizio e non firma sessioni.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { exitOnBadSessionSecret } = await import("./server/session-secret");
    exitOnBadSessionSecret();
    const { installConfig } = await import("./server/env");
    try {
      installConfig();
    } catch (err) {
      console.error(`[tailticket] ${(err as Error).message}`);
      process.exit(1);
    }
    const { cachedEffectiveWriteMode } = await import("./server/system/write-mode");
    void cachedEffectiveWriteMode().then(
      (m) => console.log(`[tailticket] modalità di scrittura: configurata ${m.configured}, effettiva ${m.effective}${m.reasons.length ? ` (${m.reasons.join(", ")})` : ""}`),
      (err: unknown) => console.error("[tailticket] modalità di scrittura non determinata", err),
    );
  }
}
