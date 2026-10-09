import "server-only";

import { sql, type RawBuilder } from "kysely";

import { db, table, type DbOrTx } from "../../db";

/**
 * Ricerca full-text di MysqlSearchBackend::find (include/class.search.php) sulla tabella `_search`.
 * Risultati ricondotti al ticket: entry di thread (H) → thread → ticket, ticket (T), utente (U) → suoi ticket.
 * keywordTicketIds restituisce gli id (max 500, come il PHP) in ordine di rilevanza; keywordRelevanceSql la
 * stessa ricerca come tabella derivata, senza limite; entrambe null se la query è troppo corta (nessun filtro,
 * come in PHP).
 */
const BOOLEAN_TERM = String.raw`(?:[<>~+-]?\((?:(?:[<>~+-]?[\w][\w-]*[*]?|"[^"]+")(?:\s+(?:[<>~+-]?[\w][\w-]*[*]?|"[^"]+"))+)\)|[<>~+-]?[\w][\w-]*[*]?|"[^"]+")`;
const BOOLEAN_RE = new RegExp(`^${BOOLEAN_TERM}(?:\\s+${BOOLEAN_TERM})*$`, "u");

/** Format::searchable: normalizzazione NFC e spazi. */
export function searchable(text: string): string {
  return text.normalize("NFC").replace(/(\s)\s+/gu, "$1").trim();
}

/** MysqlSearchBackend::quote: mette tra virgolette i termini con @ (indirizzi email). */
function quote(query: string): string {
  const re = /(?:([^\s"']+)|"[^"]*"|'[^']*')(\s*)/g;
  let out = "";
  for (const m of query.matchAll(re)) {
    let token = m[0].slice(0, m[0].length - m[2].length);
    if (m[1] && /@/u.test(token)) {
      const ch = m[1].indexOf('"') > 0 ? "'" : '"';
      token = ch + token + ch;
    }
    out += token + m[2];
  }
  return out || query;
}

export function buildMatch(rawQuery: string, allowBoolean = false): { query: string; boolean: boolean } | null {
  let query = searchable(rawQuery);
  if (Buffer.byteLength(query) < 3) return null;
  let boolean = false;
  if (allowBoolean && /(^|\s)["()<>~+-]/u.test(query) && BOOLEAN_RE.test(query)) {
    query = quote(query);
    boolean = true;
  }
  query = query.replace(/:+(\d+)/g, "$1");
  return { query, boolean };
}

/** FROM della ricerca: una riga per risultato `_search` ricondotto al ticket, con la rilevanza. */
function keywordRows(m: { query: string; boolean: boolean }): RawBuilder<unknown> {
  const mode = sql.raw(m.boolean ? "IN BOOLEAN MODE" : "IN NATURAL LANGUAGE MODE");
  const match = sql`MATCH (Z1.title, Z1.content) AGAINST (${m.query} ${mode})`;
  return sql`
      SELECT COALESCE(Z3.object_id, Z5.ticket_id, Z8.ticket_id) AS ticket_id, MAX(Z1.relevance) AS relevance
      FROM (SELECT Z1.object_id, Z1.object_type, ${match} AS relevance FROM ${table("_search")} Z1 WHERE ${match}) Z1
      LEFT JOIN ${table("thread_entry")} Z2 ON (Z1.object_type = 'H' AND Z1.object_id = Z2.id)
      LEFT JOIN ${table("thread")} Z3 ON (Z2.thread_id = Z3.id AND (Z3.object_type = 'T' OR Z3.object_type = 'C'))
      LEFT JOIN ${table("ticket")} Z5 ON (Z1.object_type = 'T' AND Z1.object_id = Z5.ticket_id)
      LEFT JOIN ${table("user")} Z6 ON (Z6.id = Z1.object_id AND Z1.object_type = 'U')
      LEFT JOIN ${table("ticket")} Z8 ON (Z8.user_id = Z6.id)
      GROUP BY 1`;
}

/**
 * Ricerca full-text come tabella derivata `(ticket_id, relevance)`, una riga per ticket, da mettere in JOIN
 * con la lista: la visibilità e la paginazione si applicano dopo, su tutti i risultati.
 * Differenza voluta: il PHP prende prima i 500 risultati più rilevanti di tutto l'helpdesk e solo dopo
 * applica la visibilità, quindi un agente con accesso limitato poteva non trovare ticket che vede
 * (e oltre i 500 risultati i ticket sparivano).
 */
export function keywordRelevanceSql(rawQuery: string, allowBoolean = false): RawBuilder<unknown> | null {
  const m = buildMatch(rawQuery, allowBoolean);
  if (!m) return null;
  return sql`(SELECT ticket_id, relevance FROM (${keywordRows(m)}) R WHERE ticket_id IS NOT NULL)`;
}

export async function keywordTicketIds(
  rawQuery: string,
  executor: DbOrTx = db(),
  allowBoolean = false,
): Promise<number[] | null> {
  const m = buildMatch(rawQuery, allowBoolean);
  if (!m) return null;
  const { rows } = await sql<{ ticket_id: number }>`
    SELECT ticket_id FROM (${keywordRows(m)}) R WHERE ticket_id IS NOT NULL
    ORDER BY relevance DESC
    LIMIT 500`.execute(executor);
  return rows.map((r) => Number(r.ticket_id));
}
