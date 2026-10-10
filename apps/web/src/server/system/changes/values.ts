/**
 * Valori delle righe nei changeset (before/after image), serializzati in JSON in modo che il ripristino
 * riscriva esattamente i valori originali:
 *  - datetime, date zero di osTicket ('0000-00-00 00:00:00'), DECIMAL e BIGINT oltre 2^53 arrivano dal
 *    driver come stringhe (pool con dateStrings e supportBigNumbers, src/server/db/index.ts) e restano
 *    stringhe: nessuna conversione in Date né cambio di fuso;
 *  - interi e FLOAT/DOUBLE restano numeri (testo più breve che rilegge lo stesso valore);
 *  - NULL resta null; binari e blob diventano { $b64 }; i JSON già interpretati dal driver { $json };
 *  - un oggetto Date (pool configurato diversamente) non è serializzabile senza perdere il fuso:
 *    UnsupportedValueError, la modifica diventa non annullabile.
 */
export type CellValue = string | number | null | { $b64: string } | { $json: string };
export type RowImage = Record<string, CellValue>;

export class UnsupportedValueError extends Error {
  constructor(column: string, what: string) {
    super(`${column}: valore ${what} non serializzabile`);
    this.name = "UnsupportedValueError";
  }
}

export function encodeValue(v: unknown, column: string): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new UnsupportedValueError(column, String(v));
    return v;
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Uint8Array) return { $b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
  if (v instanceof Date) throw new UnsupportedValueError(column, "Date");
  if (typeof v === "object") return { $json: JSON.stringify(v) };
  throw new UnsupportedValueError(column, typeof v);
}

/** Valore da passare al driver per riscrivere la cella. */
export function decodeValue(c: CellValue): string | number | null | Buffer {
  if (c === null || typeof c === "string" || typeof c === "number") return c;
  if ("$b64" in c) return Buffer.from(c.$b64, "base64");
  return c.$json;
}

/** Riga letta dal driver → immagine serializzata (tutte le colonne o solo `cols`). */
export function encodeRow(row: Record<string, unknown>, cols?: readonly string[]): RowImage {
  const out: RowImage = {};
  for (const c of cols ?? Object.keys(row)) out[c] = encodeValue(row[c], c);
  return out;
}

export function decodeRow(img: RowImage): Record<string, string | number | null | Buffer> {
  const out: Record<string, string | number | null | Buffer> = {};
  for (const [c, v] of Object.entries(img)) out[c] = decodeValue(v);
  return out;
}

export function sameCell(a: CellValue | undefined, b: CellValue | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function pick(img: RowImage, cols: readonly string[]): RowImage {
  const out: RowImage = {};
  for (const c of cols) out[c] = img[c] ?? null;
  return out;
}

/** Chiave di una riga dalle colonne di identità (chiave primaria), nell'ordine dato. */
export function rowKey(img: RowImage, cols: readonly string[]): string {
  return JSON.stringify(cols.map((c) => img[c] ?? null));
}

/**
 * Valore inserito (dal query builder) e valore riletto sono lo stesso? Confronto debole come quello di
 * MySQL per i tipi semplici (true → 1, 5 → "5"); per gli altri tipi nessun controllo.
 */
export function looselyStored(inserted: unknown, stored: CellValue): boolean {
  if (inserted === null || inserted === undefined) return stored === null;
  if (typeof inserted === "boolean") inserted = inserted ? 1 : 0;
  if (typeof inserted !== "string" && typeof inserted !== "number") return true;
  if (stored === null || typeof stored === "object") return false;
  return String(inserted) === String(stored) || (typeof stored === "number" && Number(inserted) === stored);
}
