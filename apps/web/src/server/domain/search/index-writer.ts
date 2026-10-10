import "server-only";

import { sql } from "kysely";

import { table, type DbOrTx } from "../../db";
import { loadConfigNamespace } from "../../config/config";
import { htmlSearchable, searchable } from "../../format/text";
import { cleanFromDb, fieldConfig, fieldToString, type DateFormatOptions, type FieldDef } from "../forms/fields";

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
 * contenuto = risposte dei form del ticket indicizzabili, una per riga. `userDates`: formati e fuso
 * dell'utente corrente ($cfg->getTimezone()) per le date; senza, il fuso predefinito.
 */
export async function reindexTicket(executor: DbOrTx, ticketId: number, userDates?: DateFormatOptions): Promise<void> {
  const t = await executor.selectFrom("ticket").select(["number"]).where("ticket_id", "=", ticketId).executeTakeFirst();
  if (!t) return;
  // DynamicFormEntryAnswer: ordinamento predefinito per field__sort
  const { rows } = await sql<{ field_id: number; name: string; type: string; value: string | null; configuration: string | null }>`
    SELECT V.field_id, FF.name, FF.type, V.value, FF.configuration FROM ${table("form_entry_values")} V
    JOIN ${table("form_entry")} E ON (E.id = V.entry_id)
    JOIN ${table("form_field")} FF ON (FF.id = V.field_id)
    WHERE E.object_type = 'T' AND E.object_id = ${ticketId}
    ORDER BY FF.sort, V.entry_id, V.field_id`.execute(executor);
  // Ticket::loadDynamicData: una risposta per nome di campo (l'ultima vince, posizione della prima)
  const answers = new Map<string, { type: string; value: string | null; configuration: string | null; fieldId: number }>();
  for (const r of rows) answers.set(r.name ? r.name.toLowerCase() : `field.${r.field_id}`, { type: r.type, value: r.value, configuration: r.configuration, fieldId: r.field_id });
  const content: string[] = [];
  let dates: DateFormatOptions | null = userDates ?? null;
  for (const a of answers.values()) {
    if (NOT_SEARCHABLE.has(a.type) || a.value === null) continue;
    let v: string;
    if (a.type === "memo") v = htmlSearchable(a.value);
    else if (a.type === "bool" || a.type === "datetime" || a.type === "phone") {
      // FormField::searchable → toString: Yes/No, data formattata (fuso dell'utente), telefono formattato
      if (!dates) {
        const cfg = await loadConfigNamespace("core", executor);
        dates = { cfg, timezone: cfg.str("default_timezone") || "UTC" };
      }
      const f: FieldDef = { id: a.fieldId, formId: 0, type: a.type, label: "", name: "", hint: "", flags: 0, sort: 0, config: fieldConfig(a.type, a.configuration, dates.cfg) };
      v = searchable(fieldToString(f, cleanFromDb(f, a.value, null), dates));
    } else v = searchable(answerText(a.type, a.value));
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
