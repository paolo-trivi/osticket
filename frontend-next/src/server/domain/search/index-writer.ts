import "server-only";

import { sql } from "kysely";

import { table, type DbOrTx } from "../../db";
import { htmlSearchable, searchable } from "../../format/text";

/**
 * Aggiornamento dell'indice full-text `_search` come MysqlSearchBackend::update (include/class.search.php):
 * REPLACE INTO … SET object_type, object_id, content, title. Niente riga se titolo e contenuto sono vuoti.
 */
export async function replaceSearchRow(
  executor: DbOrTx,
  objectType: "H" | "T" | "U" | "O" | "K" | "A",
  objectId: number,
  content: string,
  title: string,
): Promise<void> {
  if (!content && !title) return;
  if (!objectId) return;
  await sql`REPLACE INTO ${table("_search")} SET object_type = ${objectType}, object_id = ${objectId},
    content = ${content}, title = ${title}`.execute(executor);
}

export async function deleteSearchRow(executor: DbOrTx, objectType: string, objectId: number): Promise<void> {
  await sql`DELETE FROM ${table("_search")} WHERE object_type = ${objectType} AND object_id = ${objectId}`.execute(executor);
}

/** Campi senza testo indicizzabile (searchable() restituisce null nel PHP). */
const NOT_SEARCHABLE = new Set(["priority", "topic", "sla", "timezone", "department", "assignee", "thread", "break", "info"]);

/**
 * Signal model.updated/created per un Ticket (SearchBackend::updateModel): titolo "numero oggetto",
 * contenuto = risposte dei form del ticket indicizzabili, una per riga.
 */
export async function reindexTicket(executor: DbOrTx, ticketId: number): Promise<void> {
  const t = await executor.selectFrom("ticket").select(["number"]).where("ticket_id", "=", ticketId).executeTakeFirst();
  if (!t) return;
  const { rows } = await sql<{ field_id: number; name: string; type: string; value: string | null }>`
    SELECT V.field_id, FF.name, FF.type, V.value FROM ${table("form_entry_values")} V
    JOIN ${table("form_entry")} E ON (E.id = V.entry_id)
    JOIN ${table("form_field")} FF ON (FF.id = V.field_id)
    WHERE E.object_type = 'T' AND E.object_id = ${ticketId}
    ORDER BY V.entry_id, V.field_id`.execute(executor);
  // Ticket::loadDynamicData: una risposta per nome di campo (l'ultima vince)
  const answers = new Map<string, { type: string; value: string | null }>();
  for (const r of rows) answers.set(r.name ? r.name.toLowerCase() : `field.${r.field_id}`, { type: r.type, value: r.value });
  const content: string[] = [];
  for (const a of answers.values()) {
    if (NOT_SEARCHABLE.has(a.type) || a.value === null) continue;
    const v = a.type === "memo" ? htmlSearchable(a.value) : searchable(answerText(a.type, a.value));
    if (v) content.push(v);
  }
  const subject = answers.get("subject");
  const title = `${t.number} ${searchable(subject ? answerText(subject.type, subject.value ?? "") : "")}`;
  await replaceSearchRow(executor, "T", ticketId, content.join("\n").trim(), title);
}

function answerText(type: string, value: string): string {
  if (type === "choices" || type.startsWith("list-")) {
    try {
      const parsed = JSON.parse(value) as Record<string, string> | string[];
      if (parsed && typeof parsed === "object") return Object.values(parsed).join(", ");
    } catch {
      /* valore semplice */
    }
  }
  return value;
}
