import "server-only";

import { DateTime } from "luxon";

import { TaskModel } from "@/lib/osticket/flags";

import type { FieldErrorCode } from "../forms/fields";
import type { WriteContext } from "../ticket/context";
import type { TaskDbRow } from "./model";

/** Esiti e utilità comuni alle scritture sui task. */

export type TaskError =
  | "not_found" | "forbidden" | "note_required" | "response_required" | "title_required" | "dept_required"
  | "already_assigned" | "unavailable" | "unknown_assignee" | "team_disabled" | "team_empty" | "same_dept"
  | "not_closeable" | "no_change" | "due_past" | "invalid_date" | "already_status" | "invalid";

/** `fields`: errori dei campi del form del task (nome o id del campo → codice), in creazione e modifica. */
export type TaskResult<T = object> = ({ ok: true } & T) | { ok: false; error: TaskError; fields?: Record<string, FieldErrorCode> };

/** Esito dei campi del form non validi: `title_required` se manca il titolo, altrimenti `invalid`, con i codici per campo. */
export function invalidFields(errors: Record<string, FieldErrorCode>): { ok: false; error: TaskError; fields: Record<string, FieldErrorCode> } {
  return { ok: false, error: errors.title ? "title_required" : "invalid", fields: errors };
}

export const isOpen = (t: TaskDbRow) => (t.flags & TaskModel.ISOPEN) !== 0;

export function bodyFormat(ctx: WriteContext): "html" | "text" {
  return ctx.cfg.bool("enable_richtext") ? "html" : "text";
}

/** Converte un istante ISO nel formato del DB ('Y-m-d H:i:s' nel fuso del DB). */
export function isoToDb(iso: string, dbZone: string): string | null {
  const dt = DateTime.fromISO(iso, { setZone: true });
  if (!dt.isValid) return null;
  return dt.setZone(dbZone).toFormat("yyyy-MM-dd HH:mm:ss");
}
