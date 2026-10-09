import "server-only";

import { NOW, type DbOrTx } from "../../db";
import { TicketPerm } from "../staff/staff";
import { CollabFlag } from "./collab";
import type { WriteContext } from "./context";
import type { EditResult } from "./edit";
import { logTicketEvent } from "./events";
import { ticketThread } from "./merge-flags";
import { TicketRecord, type TicketColumns } from "./record";
import { checkStaffPerm, loadTicket, roleOn, type TicketDetail } from "./ticket";

/**
 * Collaboratori del ticket (area "ticketedit"): aggiunta (ajax.thread.php addCollaborator,
 * scp/tickets.php do=addcc, Ticket::addCollaborator → Thread::addCollaborator → Collaborator::add),
 * rimozione e attivazione (ajax.thread.php updateCollaborators → Thread::updateCollaborators).
 *
 * Permessi: gli endpoint ajax del PHP controllano solo l'accesso al ticket, mentre la vista mostra la
 * gestione dei collaboratori solo con ticket.reply o ticket.edit: qui si richiede uno dei due
 * (regola più stretta, bug di permessi del PHP non replicato).
 */

async function guard(ctx: WriteContext, ticketId: number): Promise<{ t: TicketDetail; rec: TicketRecord; threadId: number } | { error: string }> {
  const { tx, agent } = ctx;
  if (!agent) return { error: "denied" };
  const t = await loadTicket(ticketId, agent.id, tx);
  if (!t || !(await checkStaffPerm(t, agent, undefined, tx))) return { error: "not_found" };
  const role = roleOn(t, agent);
  if (!role.perms.has(TicketPerm.REPLY) && !role.perms.has(TicketPerm.EDIT)) return { error: "denied" };
  const rec = await TicketRecord.load(tx, ticketId, true);
  const thread = await ticketThread(tx, ticketId);
  if (!rec || !thread) return { error: "not_found" };
  return { t, rec, threadId: thread.id };
}

/** Nome dell'utente come User::getName()->getOriginal() (nome salvato). */
async function userName(tx: DbOrTx, userId: number): Promise<string | null> {
  const u = await tx.selectFrom("user").select("name").where("id", "=", userId).executeTakeFirst();
  return u ? u.name : null;
}

/**
 * Ticket::addCollaborator (con evento): il proprietario non può essere collaboratore; un utente già
 * collaboratore non viene aggiunto. Nuova riga con flag ACTIVE|CC (setCc non cambia nulla), evento
 * "collab" `{"add":{"<user_id>":{"name":"…"}}}`. Esportata per l'unione dei ticket (merge).
 */
export async function addTicketCollaborator(
  ctx: WriteContext,
  ticket: Pick<TicketColumns, "user_id"> & TicketColumns,
  threadId: number,
  userId: number,
  event = true,
): Promise<{ id: number } | { error: string }> {
  const { tx } = ctx;
  if (userId === ticket.user_id) return { error: "owner" };
  const name = await userName(tx, userId);
  if (name === null) return { error: "unknown_user" };
  const existing = await tx.selectFrom("thread_collaborator").select("id").where("thread_id", "=", threadId).where("user_id", "=", userId).executeTakeFirst();
  if (existing) return { error: "already_collaborator" };
  const res = await tx
    .insertInto("thread_collaborator")
    .values({ flags: CollabFlag.ACTIVE | CollabFlag.CC, thread_id: threadId, user_id: userId, role: "M", created: NOW, updated: NOW })
    .executeTakeFirstOrThrow();
  if (event) await logTicketEvent(tx, ticket, threadId, ctx.actor, "collab", { add: { [String(userId)]: { name } } });
  return { id: Number(res.insertId) };
}

/** Aggiunta di un collaboratore esistente (ajax add-collaborator / do=addcc). */
export async function addCollaborator(ctx: WriteContext, input: { ticketId: number; userId: number }): Promise<EditResult & { id?: number }> {
  const g = await guard(ctx, input.ticketId);
  if ("error" in g) return g;
  const r = await addTicketCollaborator(ctx, g.rec.row, g.threadId, input.userId);
  if ("error" in r) return r;
  return { ok: true, id: r.id };
}

/**
 * Thread::updateCollaborators: `del` = collaboratori da rimuovere (evento "collab" con `del` per
 * ognuno), `cid` = collaboratori attivi. Gli attivi ricevono `updated = NOW()` e il flag ACTIVE; tutti
 * gli altri collaboratori del thread perdono ACTIVE e ricevono comunque `updated = NOW()` (come il PHP).
 */
export async function updateCollaborators(ctx: WriteContext, input: { ticketId: number; del?: number[]; cid?: number[] }): Promise<EditResult> {
  const g = await guard(ctx, input.ticketId);
  if ("error" in g) return g;
  const { tx } = ctx;
  const { threadId, rec } = g;

  for (const id of (input.del ?? []).filter(Boolean)) {
    const c = await tx.selectFrom("thread_collaborator").select(["id", "thread_id", "user_id"]).where("id", "=", id).executeTakeFirst();
    // Il PHP registra l'evento anche se l'id è di un altro thread (e va in errore se non esiste)
    if (!c) continue;
    if (c.thread_id === threadId) await tx.deleteFrom("thread_collaborator").where("id", "=", c.id).execute();
    const name = (await userName(tx, c.user_id)) ?? "";
    await logTicketEvent(tx, rec.row, threadId, ctx.actor, "collab", { del: { [String(c.user_id)]: { name } } });
  }

  const cids = (input.cid ?? []).filter(Boolean);
  if (cids.length) {
    await tx.updateTable("thread_collaborator").set({ updated: NOW }).where("thread_id", "=", threadId).where("id", "in", cids).execute();
    for (const id of cids) {
      // Il PHP riattiva anche collaboratori di altri thread (Collaborator::lookup senza filtro): qui no
      const c = await tx.selectFrom("thread_collaborator").select(["id", "flags"]).where("id", "=", id).where("thread_id", "=", threadId).executeTakeFirst();
      if (c && !(c.flags & CollabFlag.ACTIVE)) {
        await tx.updateTable("thread_collaborator").set({ flags: c.flags | CollabFlag.ACTIVE, updated: NOW }).where("id", "=", c.id).execute();
      }
    }
  }
  let inactive = tx.selectFrom("thread_collaborator").select(["id", "flags"]).where("thread_id", "=", threadId);
  inactive = inactive.where("id", "not in", cids.length ? cids : [0]);
  const rows = await inactive.execute();
  for (const c of rows) {
    if (c.flags & CollabFlag.ACTIVE) {
      await tx.updateTable("thread_collaborator").set({ flags: c.flags & ~CollabFlag.ACTIVE, updated: NOW }).where("id", "=", c.id).execute();
    }
  }
  if (rows.length) await tx.updateTable("thread_collaborator").set({ updated: NOW }).where("id", "in", rows.map((r) => r.id)).execute();
  return { ok: true };
}
