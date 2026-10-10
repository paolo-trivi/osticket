/**
 * Mappa in memoria con scadenza delle voci e tetto massimo: base dello stato di sicurezza tenuto nel
 * processo (tentativi falliti, codici 2FA, sessioni revocate), che altrimenti crescerebbe senza limite.
 * Le voci scadute si eliminano ogni SWEEP_EVERY scritture (e alla lettura); oltre il tetto si scartano
 * le voci inserite per prime.
 */
const SWEEP_EVERY = 256;

export class BoundedStore<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();
  private writes = 0;

  constructor(private readonly maxEntries: number) {}

  /** Valore non scaduto (secondi epoch) della chiave, o undefined. */
  get(key: string, now = Date.now() / 1000): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= now) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  /** Salva il valore fino a `expires` (secondi epoch); la chiave torna in coda all'ordine di inserimento. */
  set(key: string, value: V, expires: number, now = Date.now() / 1000): void {
    this.map.delete(key);
    this.map.set(key, { value, expires });
    this.writes += 1;
    if (this.writes % SWEEP_EVERY === 0) this.sweep(now);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  private sweep(now: number): void {
    for (const [k, e] of this.map) if (e.expires <= now) this.map.delete(k);
  }
}
