"use server";

import { revalidatePath } from "next/cache";

import { formFlag, formHtml, formNum, formStr } from "@/server/actions/form-data";
import { clientIp } from "@/server/auth/session";
import { currentAgent } from "@/server/auth/staff-auth";
import { assignTicket, claimTicket, referTicket, releaseTicket, removeReferrals } from "@/server/domain/ticket/assign";
import type { WriteContext } from "@/server/domain/ticket/context";
import { ticketHardDelete } from "@/server/domain/ticket/delete";
import { changeTicketStatus, markTicketAnswered, type ActionResult } from "@/server/domain/ticket/ticket-state";
import { transferTicket } from "@/server/domain/ticket/transfer";
import { runWrite } from "@/server/domain/write";

/**
 * Server action delle azioni sul ticket (area "actions"): assegnazione, presa in carico, rilascio,
 * trasferimento, referral, cambio stato, segna risposto/non risposto. Sessione e permessi sono
 * ricontrollati qui e nei servizi di dominio.
 */

export interface TicketActionState {
  ok?: boolean;
  error?: string;
  detail?: string;
  warn?: string;
  /** referral rimossi (gestione referral) */
  removed?: number;
  nonce?: number;
}

async function run(ticketId: number, fn: (ctx: WriteContext) => Promise<ActionResult & { removed?: number }>): Promise<TicketActionState> {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired" };
  if (!ticketId) return { error: "not_found" };
  const r = await runWrite({ agent, ip: await clientIp() }, fn);
  if ("error" in r) return { error: r.error, detail: r.detail, nonce: Date.now() };
  // Vista, code e contatori mostrano assegnatario/stato/reparto: si invalida la cache del router per
  // tutte le pagine (sono dinamiche; il percorso letterale non corrisponderebbe a [locale] e ai gruppi)
  revalidatePath("/", "layout");
  return { ok: true, warn: r.warn, removed: r.removed, nonce: Date.now() };
}

const ticketIdOf = (form: FormData) => formNum(form, "ticketId");

export async function assignAction(_prev: TicketActionState, form: FormData): Promise<TicketActionState> {
  const ticketId = ticketIdOf(form);
  return run(ticketId, (ctx) =>
    assignTicket(ctx, {
      ticketId,
      assignee: formStr(form, "assignee"),
      refer: formFlag(form, "refer"),
      comments: formHtml(form),
    }),
  );
}

export async function claimAction(_prev: TicketActionState, form: FormData): Promise<TicketActionState> {
  const ticketId = ticketIdOf(form);
  return run(ticketId, (ctx) => claimTicket(ctx, { ticketId, comments: formHtml(form) }));
}

export async function releaseAction(_prev: TicketActionState, form: FormData): Promise<TicketActionState> {
  const ticketId = ticketIdOf(form);
  return run(ticketId, (ctx) =>
    releaseTicket(ctx, { ticketId, staff: formFlag(form, "sid"), team: formFlag(form, "tid"), comments: formHtml(form) }),
  );
}

export async function transferAction(_prev: TicketActionState, form: FormData): Promise<TicketActionState> {
  const ticketId = ticketIdOf(form);
  return run(ticketId, (ctx) =>
    transferTicket(ctx, { ticketId, deptId: formNum(form, "dept"), refer: formFlag(form, "refer"), comments: formHtml(form) }),
  );
}

export async function referAction(_prev: TicketActionState, form: FormData): Promise<TicketActionState> {
  const ticketId = ticketIdOf(form);
  const target = formStr(form, "target");
  if (target !== "agent" && target !== "team" && target !== "dept") return { error: "unknown_referee", nonce: Date.now() };
  return run(ticketId, (ctx) => referTicket(ctx, { ticketId, target, id: formNum(form, target), comments: formHtml(form) }));
}

export async function statusAction(_prev: TicketActionState, form: FormData): Promise<TicketActionState> {
  const ticketId = ticketIdOf(form);
  // ajax setTicketStatus passa $_REQUEST['comments'] così com'è: la pulizia la fa ThreadEntryBody
  return run(ticketId, (ctx) =>
    changeTicketStatus(
      ctx,
      { ticketId, statusId: formNum(form, "statusId"), comments: formHtml(form, "comments", { sanitize: false }), children: formFlag(form, "children") },
      // AGGANCIO "ticketedit": stato "deleted" → Ticket::delete (anche dei figli, vedi ticketHardDelete)
      { hardDelete: ticketHardDelete({ children: formFlag(form, "children") }) },
    ),
  );
}

/** ajax refer do=manage: rimozione dei referral selezionati (campi "remove" con l'id del referral). */
export async function removeReferralsAction(_prev: TicketActionState, form: FormData): Promise<TicketActionState> {
  const ticketId = ticketIdOf(form);
  const ids = form.getAll("remove").map((v) => Number(v));
  if (!ids.length) return { error: "referral_required", nonce: Date.now() };
  return run(ticketId, (ctx) => removeReferrals(ctx, { ticketId, ids }));
}

export async function markAction(_prev: TicketActionState, form: FormData): Promise<TicketActionState> {
  const ticketId = ticketIdOf(form);
  return run(ticketId, (ctx) => markTicketAnswered(ctx, { ticketId, answered: formFlag(form, "answered"), comments: formHtml(form) }));
}
