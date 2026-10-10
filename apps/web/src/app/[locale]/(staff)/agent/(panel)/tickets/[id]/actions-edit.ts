"use server";

import { revalidatePath } from "next/cache";

import { FormType } from "@/lib/osticket/object-types";
import { formFlag, formHtml, formIds, formNum, formStr, formStrs } from "@/server/actions/form-data";
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
import { agentLocalToIso } from "@/server/domain/ticket/edit-values";
import { lookupTicketsByNumber, mergeTickets, unlinkTickets, type TicketNumberHit } from "@/server/domain/ticket/merge";
import { markTicketOverdue, setTicketEmailBan } from "@/server/domain/ticket/overdue";
import { changeTicketStatus } from "@/server/domain/ticket/ticket-state";
import { runWrite } from "@/server/domain/write";
import { agentTimeZone } from "@/server/format/datetime";

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

const ticketIdOf = (form: FormData) => formNum(form, "ticketId");

/** Valori dei campi dei form del ticket (chiavi `f.<id>`) → $_POST per nome del campo. */
async function ticketFormVars(ticketId: number, form: FormData): Promise<Record<string, unknown>> {
  const cfg = await coreConfig();
  const entries = await db().selectFrom("form_entry").select("form_id").where("object_type", "=", FormType.TICKET).where("object_id", "=", ticketId).execute();
  const defs = [];
  for (const e of entries) defs.push(await loadFormDef(db(), cfg, { id: e.form_id }, "staff"));
  return formDataToVars(form, defs);
}

/** scp/tickets.php a=update: form "Modifica ticket". */
export async function updateTicketAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  const vars = await ticketFormVars(ticketId, form);
  return run(ticketId, async (ctx) =>
    updateTicket(ctx, {
      ticketId,
      topicId: formStr(form, "topicId"),
      slaId: formStr(form, "slaId"),
      source: formStr(form, "source"),
      // scadenza nel fuso dell'agente (agentLocalToIso)
      duedate: agentLocalToIso(formStr(form, "duedate"), await agentTimeZone(ctx.agent ?? null)),
      userId: formStr(form, "user_id") || undefined,
      note: formStr(form, "note"),
      vars,
    }),
  );
}

/** ajax editField: un solo campo (field = priority|topic|sla|source|duedate|<id>). */
export async function updateFieldAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  const field = formStr(form, "field");
  let vars: Record<string, unknown>;
  switch (field) {
    case "topic":
      vars = { topic_id: formStr(form, "value") };
      break;
    case "sla":
      vars = { sla_id: formStr(form, "value") };
      break;
    case "source":
      vars = { source: formStr(form, "value") };
      break;
    case "duedate":
      vars = { duedate: formStr(form, "value") };
      break;
    default:
      vars = await ticketFormVars(ticketId, form);
  }
  return run(ticketId, async (ctx) => {
    // editField: DateTimeField nel fuso dell'agente
    if (field === "duedate") vars.duedate = agentLocalToIso(String(vars.duedate), await agentTimeZone(ctx.agent ?? null));
    return updateTicketField(ctx, {
      ticketId,
      field,
      vars,
      comments: formHtml(form),
    });
  });
}

/** do=changeuser */
export async function changeOwnerAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  return run(ticketId, (ctx) => changeTicketOwner(ctx, { ticketId, userId: formNum(form, "userId") }));
}

/** ajax add-collaborator (utente esistente) */
export async function addCollaboratorAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  return run(ticketId, (ctx) => addCollaborator(ctx, { ticketId, userId: formNum(form, "userId") }));
}

/** ajax collaborators: rimozione (`del`) e collaboratori attivi (`cid`). */
export async function updateCollaboratorsAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  const del = formIds(form, "del");
  const cid = formIds(form, "cid").filter((id) => !del.includes(id));
  return run(ticketId, (ctx) => updateCollaborators(ctx, { ticketId, del, cid }));
}

/** ajax updateMerge (tids) dal dialogo di merge/link. */
export async function mergeAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  const title = formStr(form, "title") === "link" ? "link" : "merge";
  // ajax updateMerge: con `dtids[]` (ticket collegati tolti dall'elenco) si scollega soltanto, `tids` è ignorato
  const dtids = formIds(form, "dtids");
  if (dtids.length) return run(ticketId, (ctx) => unlinkTickets(ctx, { ticketIds: dtids }));
  const numbers = formStrs(form, "tids").filter(Boolean);
  if (numbers.length < 2) return { error: "select_two", nonce: Date.now() };
  return run(ticketId, (ctx) =>
    mergeTickets(ctx, {
      title,
      numbers,
      combine: title === "link" ? "2" : formStr(form, "combine") || "1",
      participants: formStr(form, "participants") || "all",
      childStatusId: formNum(form, "childStatusId") || undefined,
      parentStatusId: formNum(form, "parentStatusId") || undefined,
      deleteChild: formFlag(form, "deleteChild"),
      moveTasks: formFlag(form, "moveTasks"),
    }),
  );
}

/** ajax updateMerge (dtids): scollegamento. */
export async function unlinkAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  const ids = formIds(form, "dtids");
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
  return run(ticketId, (ctx) => setTicketEmailBan(ctx, { ticketId, ban: formFlag(form, "ban") }));
}

/**
 * "Elimina ticket" (status-options/ticket-status con lo stato "deleted"): ajax setTicketStatus con
 * Ticket::delete. I commenti passano grezzi come $_REQUEST['comments'].
 */
export async function deleteTicketAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  const statusId = formNum(form, "statusId");
  const children = formFlag(form, "children");
  const comments = formHtml(form, "comments", { sanitize: false });
  return run(
    ticketId,
    async (ctx) => {
      const r = await changeTicketStatus(ctx, { ticketId, statusId, comments, children }, { hardDelete: ticketHardDelete({ children }) });
      return "error" in r ? { error: r.error } : { ok: true };
    },
    true,
  );
}

/** TEA_EditThreadEntry: nuova versione di una voce del thread. */
export async function editEntryAction(_prev: EditActionState, form: FormData): Promise<EditActionState> {
  const ticketId = ticketIdOf(form);
  const entryId = formNum(form, "entryId");
  return run(ticketId, async (ctx) => {
    const r = await editThreadEntry(ctx, { ticketId, entryId, body: formStr(form, "body"), title: formStr(form, "title") });
    return "error" in r ? r : { ok: true };
  });
}

/** Ricerca utenti (ajax.php/users?q=) per proprietario e collaboratori. */
export async function searchUsersAction(q: string): Promise<UserHit[]> {
  const agent = await currentAgent();
  if (!agent) return [];
  return searchUsers(db(), q, 10);
}

/** ajax.php/tickets/number-lookup: ticket per numero (prefisso) per "Aggiungi un ticket" di merge/link. */
export async function searchTicketsAction(q: string): Promise<TicketNumberHit[]> {
  const agent = await currentAgent();
  if (!agent || q.trim().length < 3) return [];
  return lookupTicketsByNumber(db(), agent, q);
}
