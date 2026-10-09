"use server";

import { revalidatePath } from "next/cache";

import { clientIp } from "@/server/auth/session";
import { currentAgent } from "@/server/auth/staff-auth";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { loadFormDef } from "@/server/domain/forms/load";
import { editThreadEntry } from "@/server/domain/thread/edit";
import { addCollaborator, updateCollaborators } from "@/server/domain/ticket/collaborators";
import type { WriteContext } from "@/server/domain/ticket/context";
import { formDataToVars, searchUsers, type UserHit } from "@/server/domain/ticket/create-ui";
import { ticketHardDelete } from "@/server/domain/ticket/delete";
import { changeTicketOwner, updateTicket, updateTicketField } from "@/server/domain/ticket/edit";
import { mergeTickets, unlinkTickets } from "@/server/domain/ticket/merge";
import { markTicketOverdue, setTicketEmailBan } from "@/server/domain/ticket/overdue";
import { changeTicketStatus } from "@/server/domain/ticket/ticket-state";
import { runWrite } from "@/server/domain/write";
import { sanitizeText } from "@/server/format/text";

/**
 * Server action dell'area "ticketedit" nella vista ticket: modifica (form completo e singolo campo),
 * proprietario, collaboratori, merge/link, eliminazione, segna scaduto, ban list, modifica delle voci
 * del thread. Sessione e permessi sono ricontrollati qui e nei servizi di dominio.
 */

export interface EditActionState {
  ok?: boolean;
  error?: string;
  /** errori per campo (codici) */
  fields?: Record<string, string[]>;
  /** il ticket non esiste più (eliminato): la UI torna alla lista */
  gone?: boolean;
  /** email della ban list (messaggio di conferma) */
  email?: string;
  nonce?: number;
}

type DomainResult = { ok: true; email?: string } | { error: string; fields?: Record<string, string[]> };

async function run(ticketId: number, fn: (ctx: WriteContext) => Promise<DomainResult>, gone = false): Promise<EditActionState> {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired", nonce: Date.now() };
  if (!ticketId) return { error: "not_found", nonce: Date.now() };
  const r = await runWrite({ agent, ip: await clientIp() }, fn);
  if ("error" in r) return { error: r.error, fields: r.fields, nonce: Date.now() };
  // Ticket eliminato: niente rivalidazione della vista (darebbe "non trovato" prima del ritorno
  // alla lista); la lista è dinamica e viene ricaricata dalla navigazione del client
  if (!gone) revalidatePath("/", "layout");
  return { ok: true, gone, email: r.email, nonce: Date.now() };
}

const ticketIdOf = (form: FormData) => Number(form.get("ticketId") ?? 0);
const str = (form: FormData, k: string) => String(form.get(k) ?? "");

/** Commento HTML dei form (TextareaField html → Format::sanitize); vuoto se contiene solo tag e spazi. */
function comments(form: FormData, key = "comments"): string {
  const raw = str(form, key);
  if (!raw.replace(/<[^>]*>|&nbsp;|\s/g, "")) return "";
  return sanitizeText(raw);
}

/** Valori dei campi dei form del ticket (chiavi `f.<id>`) → $_POST per nome del campo. */
async function ticketFormVars(ticketId: number, form: FormData): Promise<Record<string, unknown>> {
  const cfg = await coreConfig();
  const entries = await db().selectFrom("form_entry").select("form_id").where("object_type", "=", "T").where("object_id", "=", ticketId).execute();
  const defs = [];
  for (const e of entries) defs.push(await loadFormDef(db(), cfg, { id: e.form_id }, "staff"));
  return formDataToVars(form, defs);
}

/** scp/tickets.php a=update: form "Modifica ticket". */
export async function updateTicketAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  const vars = await ticketFormVars(ticketId, form);
  return run(ticketId, (ctx) =>
    updateTicket(ctx, {
      ticketId,
      topicId: str(form, "topicId"),
      slaId: str(form, "slaId"),
      source: str(form, "source"),
      duedate: str(form, "duedate").replace("T", " "),
      userId: str(form, "user_id") || undefined,
      note: str(form, "note"),
      vars,
    }),
  );
}

/** ajax editField: un solo campo (field = priority|topic|sla|source|duedate|<id>). */
export async function updateFieldAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  const field = str(form, "field");
  let vars: Record<string, unknown>;
  switch (field) {
    case "topic":
      vars = { topic_id: str(form, "value") };
      break;
    case "sla":
      vars = { sla_id: str(form, "value") };
      break;
    case "source":
      vars = { source: str(form, "value") };
      break;
    case "duedate":
      vars = { duedate: str(form, "value").replace("T", " ") };
      break;
    default:
      vars = await ticketFormVars(ticketId, form);
  }
  return run(ticketId, (ctx) => updateTicketField(ctx, { ticketId, field, vars, comments: comments(form) }));
}

/** do=changeuser */
export async function changeOwnerAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  return run(ticketId, (ctx) => changeTicketOwner(ctx, { ticketId, userId: Number(form.get("userId") ?? 0) }));
}

/** ajax add-collaborator (utente esistente) */
export async function addCollaboratorAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  return run(ticketId, (ctx) => addCollaborator(ctx, { ticketId, userId: Number(form.get("userId") ?? 0) }));
}

/** ajax collaborators: rimozione (`del`) e collaboratori attivi (`cid`). */
export async function updateCollaboratorsAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  const del = form.getAll("del").map(Number).filter(Boolean);
  const cid = form.getAll("cid").map(Number).filter((id) => id && !del.includes(id));
  return run(ticketId, (ctx) => updateCollaborators(ctx, { ticketId, del, cid }));
}

/** ajax updateMerge (tids) dal dialogo di merge/link. */
export async function mergeAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  const title = str(form, "title") === "link" ? "link" : "merge";
  const numbers = form.getAll("tids").map(String).filter(Boolean);
  if (numbers.length < 2) return { error: "select_two", nonce: Date.now() };
  return run(ticketId, (ctx) =>
    mergeTickets(ctx, {
      title,
      numbers,
      combine: title === "link" ? "2" : str(form, "combine") || "1",
      participants: str(form, "participants") || "all",
      childStatusId: Number(form.get("childStatusId") ?? 0) || undefined,
      parentStatusId: Number(form.get("parentStatusId") ?? 0) || undefined,
      deleteChild: form.get("deleteChild") === "1",
      moveTasks: form.get("moveTasks") === "1",
    }),
  );
}

/** ajax updateMerge (dtids): scollegamento. */
export async function unlinkAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  const ids = form.getAll("dtids").map(Number).filter(Boolean);
  if (!ids.length) return { error: "select_tickets", nonce: Date.now() };
  return run(ticketId, (ctx) => unlinkTickets(ctx, { ticketIds: ids }));
}

/** do=overdue */
export async function overdueAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  return run(ticketId, (ctx) => markTicketOverdue(ctx, { ticketId }));
}

/** do=banemail / unbanemail */
export async function banAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  return run(ticketId, (ctx) => setTicketEmailBan(ctx, { ticketId, ban: form.get("ban") === "1" }));
}

/**
 * "Elimina ticket" (status-options/ticket-status con lo stato "deleted"): ajax setTicketStatus con
 * Ticket::delete. I commenti passano grezzi come $_REQUEST['comments'].
 */
export async function deleteTicketAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  const statusId = Number(form.get("statusId") ?? 0);
  const children = form.get("children") === "1";
  const raw = str(form, "comments");
  return run(
    ticketId,
    async (ctx) => {
      const r = await changeTicketStatus(ctx, { ticketId, statusId, comments: raw.replace(/<[^>]*>|&nbsp;|\s/g, "") ? raw : "", children }, { hardDelete: ticketHardDelete({ children }) });
      return "error" in r ? { error: r.error } : { ok: true };
    },
    true,
  );
}

/** TEA_EditThreadEntry: nuova versione di una voce del thread. */
export async function editEntryAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  const entryId = Number(form.get("entryId") ?? 0);
  return run(ticketId, async (ctx) => {
    const r = await editThreadEntry(ctx, { ticketId, entryId, body: str(form, "body"), title: str(form, "title") });
    return "error" in r ? r : { ok: true };
  });
}

/** Ricerca utenti (ajax.php/users?q=) per proprietario e collaboratori. */
export async function searchUsersAction(q: string): Promise<UserHit[]> {
  const agent = await currentAgent();
  if (!agent) return [];
  return searchUsers(db(), q, 10);
}
