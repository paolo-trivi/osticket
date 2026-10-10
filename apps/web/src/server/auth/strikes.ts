import "server-only";

import { BoundedStore } from "./bounded-store";

/**
 * Contatore dei tentativi di login falliti (equivalente di StaffAuthStrikeBackend/UserAuthStrikeBackend).
 * Il PHP lo tiene nella sessione (aggirabile scartando il cookie, doc 14 §2.3); qui è per IP+login,
 * in memoria del processo: stessa soglia e stesso timeout di config, più restrittivo.
 * Le voci inattive da più di STRIKE_TTL (o dal timeout del blocco, se più lungo) si eliminano; il numero
 * di voci ha un tetto (bounded-store.ts).
 */
interface StrikeState {
  strikes: number;
  lastStrike: number | null;
}

const STRIKE_TTL = 24 * 3600;
const MAX_ENTRIES = 100_000;

const store = new BoundedStore<StrikeState>(MAX_ENTRIES);

function key(realm: string, ip: string, login: string): string {
  return `${realm}|${ip}|${login.toLowerCase()}`;
}

function save(k: string, state: StrikeState, timeoutSec = 0): void {
  const now = Date.now() / 1000;
  store.set(k, state, now + Math.max(STRIKE_TTL, timeoutSec), now);
}

/** authTimeout(): true se il login è bloccato (e il timer viene rinnovato, come nel PHP). */
export function isLockedOut(realm: string, ip: string, login: string, timeoutSec: number): boolean {
  const k = key(realm, ip, login);
  const state = store.get(k);
  if (!state?.lastStrike) return false;
  const now = Date.now() / 1000;
  if (now - state.lastStrike < timeoutSec) {
    state.lastStrike = now;
    save(k, state, timeoutSec);
    return true;
  }
  state.lastStrike = null;
  state.strikes = 0;
  save(k, state);
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
  save(k, state);
  return { strikes: state.strikes, lockedOut };
}

export function resetStrikes(realm: string, ip: string, login: string): void {
  store.delete(key(realm, ip, login));
}
