import "server-only";

import { BoundedStore } from "./bounded-store";

/**
 * Sessioni revocate al logout (equivalente di session_destroy del PHP per i cookie firmati della app):
 * id di sessione → scadenza della sessione. In memoria del processo, come 2FA e tentativi falliti
 * (una sola istanza della app); un riavvio svuota la lista, ma le sessioni restano comunque limitate
 * dalla durata massima assoluta (session.ts).
 */
const MAX_ENTRIES = 100_000;

const revoked = new BoundedStore<true>(MAX_ENTRIES);

export function revokeSession(sid: string, expires: number): void {
  revoked.set(sid, true, expires);
}

export function isSessionRevoked(sid: string): boolean {
  return revoked.get(sid) === true;
}
