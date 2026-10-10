import "server-only";

import { sql } from "kysely";

import { FormType } from "@/lib/osticket/object-types";

import { table, type DbOrTx } from "../../db";
import type { FieldDef } from "./fields";

/**
 * Tabelle materializzate dei form (DynamicForm::updateDynamicDataView, Signal model.created /
 * model.updated delle risposte): per tipo di form la tabella `*__cdata` e la sua chiave. Next non le
 * crea né le modifica (DDL): scrive solo le colonne che il PHP ha già materializzato.
 */
const CDATA = {
  [FormType.TICKET]: { table: "ticket__cdata", key: "ticket_id" },
  [FormType.TASK]: { table: "task__cdata", key: "task_id" },
  [FormType.USER]: { table: "user__cdata", key: "user_id" },
  [FormType.ORG]: { table: "organization__cdata", key: "org_id" },
} as const;

type CdataFormType = keyof typeof CDATA;

/** Tipi di form con tabella *__cdata (ticket, task, utenti, organizzazioni). */
export const CDATA_FORM_TYPES: string[] = Object.keys(CDATA);

function cdataOf(formType: string): (typeof CDATA)[CdataFormType] | null {
  return formType in CDATA ? CDATA[formType as CdataFormType] : null;
}

/** Colonne della tabella *__cdata del tipo di form (null se il tipo non ne ha o la tabella manca). */
export async function cdataColumns(executor: DbOrTx, formType: string): Promise<Set<string> | null> {
  const c = cdataOf(formType);
  if (!c) return null;
  const res = await sql<{ Field: string }>`SHOW COLUMNS FROM ${table(c.table)}`.execute(executor).catch(() => null);
  return res ? new Set(res.rows.map((r) => String(r.Field))) : null;
}

/**
 * INSERT … ON DUPLICATE KEY UPDATE della colonna del campo (`name` o `field_<id>`) con il valore di
 * getSearchKeys. Se tabella o colonna non esistono la query del PHP fallisce senza effetti: qui non
 * viene eseguita. `columns` evita di rileggere le colonne per ogni campo della stessa entry.
 */
export async function upsertCdata(
  executor: DbOrTx,
  formType: string,
  objectId: number,
  f: Pick<FieldDef, "id" | "name">,
  keys: string,
  columns?: Set<string> | null,
): Promise<void> {
  const c = cdataOf(formType);
  if (!c) return;
  const cols = columns === undefined ? await cdataColumns(executor, formType) : columns;
  const col = f.name || `field_${f.id}`;
  if (!cols?.has(col)) return;
  await sql`INSERT INTO ${table(c.table)} SET ${sql.ref(col)} = ${keys}, ${sql.ref(c.key)} = ${objectId}
    ON DUPLICATE KEY UPDATE ${sql.ref(col)} = ${keys}`.execute(executor);
}
