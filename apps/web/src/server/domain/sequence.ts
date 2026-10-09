import "server-only";

import { randomInt } from "node:crypto";

import { NOW, type DbOrTx } from "../db";

/**
 * Numerazione condivisa da ticket e task (include/class.sequence.php, Misc::randNumber): sequenza del DB
 * bloccata con SELECT … FOR UPDATE oppure RandomSequence, formato con i "#" e ripetizione finché il
 * controllo di unicità del chiamante non approva il numero (Sequence::next($format, $check)).
 */

/** Misc::randNumber($len): prima cifra 1-9, le altre 0-9 */
export function randNumber(len = 6): number {
  let s = "";
  for (let i = 0; i < len; i++) s += String(randomInt(i === 0 ? 1 : 0, 10));
  return Number(s);
}

/** Sequence::getDigitCount: numero di "#" non preceduti da "\" */
function digitCount(format: string): number {
  return (format.match(/(?<!\\)#/g) ?? []).length;
}

/**
 * Sequence::format($format, $number): le cifre riempiono i gruppi di "#" da sinistra, con padding a
 * sinistra se sono meno dei "#"; le cifre in eccesso finiscono dopo l'ultimo gruppo; "\#" diventa "#".
 */
export function formatSequence(format: string, number: number | string, padding = "0"): string {
  const groups = [...format.matchAll(/(?<!\\)#+/g)];
  const total = groups.reduce((n, g) => n + g[0].length, 0);
  let num = String(number);
  // Sequence::isValid salva sempre un padding non vuoto ('0' di default)
  if (num.length < total) num = (padding || "0").repeat(total).slice(0, total - num.length) + num;
  let output = "";
  let start = 0;
  let noff = 0;
  for (const g of groups) {
    const size = g[0].length;
    output += format.slice(start, g.index).replaceAll("\\#", "#");
    output += num.slice(noff, noff + size);
    start = g.index! + size;
    noff += size;
  }
  if (num.length > noff) output += num.slice(noff);
  output += format.slice(start).replaceAll("\\#", "#");
  return output;
}

/**
 * Sequence::next($format, $check): con una sequenza del DB la riga viene bloccata (FOR UPDATE), `next`
 * incrementato di `increment` e `updated = NOW()`; con RandomSequence (id 0 o sequenza mancante) numeri
 * casuali di almeno 6 cifre. Senza formato restituisce il numero così com'è.
 */
export async function nextSequenceNumber(
  executor: DbOrTx,
  sequenceId: number,
  format: string,
  isUnique: (formatted: string) => Promise<boolean>,
): Promise<string> {
  const digits = digitCount(format);
  const seq = sequenceId ? await executor.selectFrom("sequence").select("id").where("id", "=", sequenceId).executeTakeFirst() : undefined;
  for (;;) {
    let next: number;
    let padding = "0";
    if (seq) {
      const locked = await executor
        .selectFrom("sequence")
        .select(["id", "next", "increment", "padding"])
        .where("id", "=", seq.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      next = Number(locked.next);
      padding = locked.padding ?? "0";
      await executor
        .updateTable("sequence")
        .set({ next: next + Number(locked.increment), updated: NOW })
        .where("id", "=", seq.id)
        .execute();
    } else {
      next = randNumber(Math.max(digits, 6));
    }
    const formatted = format ? formatSequence(format, next, padding) : String(next);
    if (await isUnique(formatted)) return formatted;
  }
}
