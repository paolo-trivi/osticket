import "server-only";

import { sql } from "kysely";

import { NOW, table } from "../../db";
import { htmlChars } from "../../format/html";
import { cleanEntryBody } from "../../format/text";
import { deleteSearchRow } from "../search/index-writer";
import { TicketPerm, type Agent } from "../staff/staff";
import type { WriteContext } from "../ticket/context";
import { ticketThread } from "../ticket/merge-flags";
import { TicketRecord } from "../ticket/record";
import { roleOnRow, stateOf } from "../ticket/status";
import { checkStaffPerm, loadTicket } from "../ticket/ticket";
import { createThreadEntry, EntryFlag } from "./write";

/**
 * Modifica di una voce del thread di un ticket (include/class.thread_actions.php TEA_EditThreadEntry
 * e TEA_EditAndResendThreadEntry senza reinvio, ThreadEntry::updateEntry). "Modifica e reinvia" non
 * è gestito: si salva solo la nuova versione.
 */

export type EntryEditResult = { ok: true; id: number; unchanged?: boolean } | { error: string };

interface EntryRow {
  id: number;
  pid: number;
  thread_id: number;
  staff_id: number;
  user_id: number;
  type: string;
  flags: number;
  poster: string | null;
  format: string;
  body: string;
  created: string;
  editor: number | null;
  editor_type: string | null;
}

/**
 * TEA_EditThreadEntry::isVisible/isEnabled (e TEA_EditAndResendThreadEntry per le risposte): voci non
 * di sistema; risposte solo se scritte da un agente; l'agente può modificare le proprie voci, quelle
 * dei ticket del reparto che gestisce, o tutte con il permesso thread.edit del suo ruolo.
 */
export function canEditEntry(entry: Pick<EntryRow, "staff_id" | "user_id" | "type">, agent: Agent, ticket: { deptManagerId: number; roleHasThreadEdit: boolean }): boolean {
  const visible = entry.type === "R" ? !!entry.staff_id : !!(entry.staff_id || entry.user_id);
  if (!visible) return false;
  return agent.id === entry.staff_id || ticket.deptManagerId === agent.id || ticket.roleHasThreadEdit;
}

/** Permessi di modifica delle voci per un ticket (per la vista). */
export async function entryEditContext(ctx: Pick<WriteContext, "tx">, ticketId: number, agent: Agent) {
  const rec = await TicketRecord.load(ctx.tx, ticketId);
  if (!rec) return null;
  const dept = await ctx.tx.selectFrom("department").select("manager_id").where("id", "=", rec.get("dept_id")).executeTakeFirst();
  const role = roleOnRow(rec.row, await stateOf(ctx.tx, rec.row), agent);
  return { deptManagerId: dept?.manager_id ?? 0, roleHasThreadEdit: role.perms.has(TicketPerm.THREAD_EDIT) };
}

/**
 * ThreadEntry::updateEntry: se il corpo pulito è identico non si scrive nulla; altrimenti nuova voce
 * figlia (pid = voce modificata) con poster, autore, tipo e thread della vecchia, titolo
 * `htmlchars($title)`, corpo nuovo, IP attuale; i destinatari NON vengono copiati (il PHP passa
 * `recipients` invece di `thread_entry_recipients`: stranezza replicata). Gli allegati non inline
 * passano alla nuova voce. Se la vecchia voce è una modifica dello stesso agente (non "guarded"),
 * viene eliminata e la nuova si aggancia all'originale. Flag della nuova voce = flag della base
 * senza HIDDEN/GUARDED più EDITED; editor = agente; created = quella della base; la base riceve HIDDEN.
 */
export async function editThreadEntry(ctx: WriteContext, input: { ticketId: number; entryId: number; body: string; title?: string }): Promise<EntryEditResult> {
  const { tx, cfg, agent } = ctx;
  if (!agent) return { error: "denied" };
  const t = await loadTicket(input.ticketId, agent.id, tx);
  if (!t || !(await checkStaffPerm(t, agent, undefined, tx))) return { error: "not_found" };
  const thread = await ticketThread(tx, input.ticketId);
  let old = (await tx.selectFrom("thread_entry").selectAll().where("id", "=", input.entryId).executeTakeFirst()) as EntryRow | undefined;
  // La voce deve appartenere al thread del ticket (tipo 'T')
  if (!old || !thread || thread.object_type !== "T" || old.thread_id !== thread.id) return { error: "not_found" };
  const perms = await entryEditContext(ctx, input.ticketId, agent);
  if (!perms || !canEditEntry(old, agent, perms)) return { error: "denied" };

  const format = old.format === "text" ? "text" : "html";
  const opts = { allowExternalImages: cfg.bool("allow_external_images"), byUser: true };
  // $new->getClean() == $old->getBody(): confronto prima di emoticon, '-' e immagini esterne
  const clean = cleanEntryBody(input.body, format, opts);
  if (clean === old.body) return { ok: true, id: old.id, unchanged: true };

  const created = await createThreadEntry(tx, cfg, {
    threadId: old.thread_id,
    type: old.type as "M" | "R" | "N",
    body: input.body,
    format,
    title: htmlChars(input.title ?? ""),
    staffId: old.staff_id,
    userId: old.user_id,
    poster: old.poster ?? "",
    pid: old.id,
    ip: ctx.actor?.ip ?? "",
    editorSpacing: true,
  });

  // Allegati non inline spostati sulla nuova voce
  await tx.updateTable("attachment").set({ object_id: created.id }).where("type", "=", "H").where("object_id", "=", old.id).where("inline", "=", 0).execute();

  let pid = old.id;
  if (old.flags & EntryFlag.EDITED && old.editor === agent.id && old.editor_type === "S" && !(old.flags & EntryFlag.GUARDED)) {
    // Sostituzione della modifica precedente: si riparte dall'originale
    const original = (await tx.selectFrom("thread_entry").selectAll().where("id", "=", old.pid).executeTakeFirst()) as EntryRow | undefined;
    pid = old.pid;
    const del = await sql`DELETE FROM ${table("thread_entry")} WHERE id = ${old.id} LIMIT 1`.execute(tx);
    if (Number(del.numAffectedRows ?? 0) === 1) await deleteSearchRow(tx, "H", old.id);
    if (original) old = original;
  }

  const flags = (old.flags & ~(EntryFlag.HIDDEN | EntryFlag.GUARDED)) | EntryFlag.EDITED;
  await tx
    .updateTable("thread_entry")
    .set({ pid, flags, editor: agent.id, editor_type: "S", created: old.created, updated: NOW })
    .where("id", "=", created.id)
    .execute();
  if (!(old.flags & EntryFlag.HIDDEN)) {
    await tx.updateTable("thread_entry").set({ flags: old.flags | EntryFlag.HIDDEN }).where("id", "=", old.id).execute();
  }
  return { ok: true, id: created.id };
}
