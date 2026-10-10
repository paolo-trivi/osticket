import { notFound } from "next/navigation";

/**
 * Id numerico di un segmento dinamico della URL (`[id]`, `[itemId]`): solo cifre decimali, intero
 * positivo e rappresentabile senza perdita. Altrimenti null (es. "abc", "0", "1.5", "-3", "1e3"),
 * così una URL malformata non arriva alle query (prima diventava `ticket_id = NaN` e un errore 500).
 */
export function parseId(raw: string | undefined | null): number | null {
  if (!raw || !/^[1-9]\d{0,15}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** Come parseId, ma una URL malformata dà la pagina 404 (pagine e generateMetadata dei dettagli). */
export function idOrNotFound(raw: string | undefined | null): number {
  const id = parseId(raw);
  if (id === null) notFound();
  return id;
}
