import "server-only";

/**
 * Contatore dei tentativi di login falliti (equivalente di StaffAuthStrikeBackend/UserAuthStrikeBackend).
 * Il PHP lo tiene nella sessione (aggirabile scartando il cookie, doc 14 §2.3); qui è per IP+login,
 * in memoria del processo: stessa soglia e stesso timeout di config, più restrittivo.
 */
interface StrikeState {
  strikes: number;
  lastStrike: number | null;
}

const store = new Map<string, StrikeState>();

function key(realm: string, ip: string, login: string): string {
  return `${realm}|${ip}|${login.toLowerCase()}`;
}

/** authTimeout(): true se il login è bloccato (e il timer viene rinnovato, come nel PHP). */
export function isLockedOut(realm: string, ip: string, login: string, timeoutSec: number): boolean {
  const state = store.get(key(realm, ip, login));
  if (!state?.lastStrike) return false;
  const now = Date.now() / 1000;
  if (now - state.lastStrike < timeoutSec) {
    state.lastStrike = now;
    return true;
  }
  state.lastStrike = null;
  state.strikes = 0;
  return false;
}

/** authStrike(): registra un fallimento. Restituisce il numero di tentativi e se è scattato il blocco. */
export function addStrike(
  realm: string,
  ip: string,
  login: string,
  maxLogins: number,
): { strikes: number; lockedOut: boolean } {
  const k = key(realm, ip, login);
  const state = store.get(k) ?? { strikes: 0, lastStrike: null };
  state.strikes += 1;
  let lockedOut = false;
  if (state.strikes > maxLogins) {
    state.lastStrike = Date.now() / 1000;
    lockedOut = true;
  }
  store.set(k, state);
  return { strikes: state.strikes, lockedOut };
}

export function resetStrikes(realm: string, ip: string, login: string): void {
  store.delete(key(realm, ip, login));
}
