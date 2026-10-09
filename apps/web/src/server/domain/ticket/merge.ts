import "server-only";

import type { DbOrTx } from "../../db";
import { phpJsonEncode } from "../../format/php-json";
import { bodySearchable } from "../../format/text";
import { replaceSearchRow } from "../search/index-writer";
import { TicketPerm } from "../staff/staff";
import { EntryFlag } from "../thread/write";
import { threadRefer } from "./assign";
import { addTicketCollaborator } from "./collaborators";
import type { WriteContext } from "./context";
import { deleteTicket } from "./delete";
import type { EditResult } from "./edit";
import { logTicketEvent } from "./events";
import { childTickets, isParentFlags, mergeTypeOf, setMergeType, setPid, TicketFlag, ticketThread } from "./merge-flags";
import { TicketRecord } from "./record";
import { setTicketStatus } from "./status";
import { checkStaffPerm, loadTicket } from "./ticket";

/**
 * Unione (merge) e collegamento (link) dei ticket: Ticket::manageMerge / Ticket::merge / unlink /
 * unlinkChild (include/class.ticket.php:2464-2628), ajax.tickets.php updateMerge.
 *
 * - link (combine = 2): il primo ticket diventa padre (FLAG_PARENT|FLAG_LINKED), gli altri figli
 *   collegati (ticket_pid, FLAG_LINKED, sort = posizione); eventi "linked" su padre e figlio.
 * - merge (combine = 1 thread combinati, 0 thread separati): come sopra con eventi "merged" e referral
 *   del reparto del figlio sul padre (evento "referred"); poi per ogni figlio: collaboratori e
 *   proprietario del figlio aggiunti al padre, voci del thread del figlio spostate nel thread del padre
 *   (FLAG_CHILD + thread_entry_merge), thread del figlio di tipo 'C' con `extra`, stato di chiusura del
 *   figlio (forzato), stato del padre, spostamento dei task ed eventuale eliminazione del figlio.
 *
 * Differenze volute (permessi, non replicate):
 * - il PHP accetta un ticket senza il permesso ticket.merge/ticket.link se il suo thread ha un
 *   qualunque referral (`Thread::isReferred()` senza destinatario): qui il permesso è sempre richiesto;
 * - il PHP controlla i permessi ticket per ticket e si ferma a metà (dopo aver già modificato i
 *   precedenti): qui tutti i ticket sono verificati prima di scrivere;
 * - lo scollegamento (`dtids`) nel PHP non controlla alcun permesso: qui serve ticket.link o
 *   ticket.merge sul ticket.
 * Stranezza replicata: per un link il PHP risponde 404 ("Unable to manage ticket") anche se il
 * collegamento è stato salvato; qui l'esito è positivo.
 */

interface MergeInput {
  /** "merge" o "link" (campo nascosto `title` del dialogo) */
  title: "merge" | "link";
  /** numeri dei ticket (`tids[]`), il primo è il padre */
  numbers: string[];
  /** 0 = thread separati, 1 = combinati, 2 = link */
  combine: string;
  /** "all" = proprietario + collaboratori del figlio, "user" = solo il proprietario */
  participants?: string;
  childStatusId?: number;
  parentStatusId?: number;
  deleteChild?: boolean;
  moveTasks?: boolean;
}

const eventData = (other: TicketRecord) => ({ ticket: `Ticket #${other.get("number")}`, id: other.id });

async function threadIdOf(tx: DbOrTx, ticketId: number): Promise<number> {
  return (await ticketThread(tx, ticketId))?.id ?? 0;
}

async function logEvent(ctx: WriteContext, rec: TicketRecord, state: "merged" | "linked" | "unlinked" | "referred", data: Record<string, unknown>) {
  const threadId = await threadIdOf(ctx.tx, rec.id);
  if (threadId) await logTicketEvent(ctx.tx, rec.row, threadId, ctx.actor, state, data);
}

/** Ticket::unlinkChild($parent) */
async function unlinkChild(ctx: WriteContext, child: TicketRecord, parent: TicketRecord): Promise<void> {
  setPid(child, null);
  child.set("sort", 1);
  child.set("flags", child.get("flags") & ~TicketFlag.LINKED);
  await child.save();
  await logEvent(ctx, child, "unlinked", eventData(parent));
  await logEvent(ctx, parent, "unlinked", eventData(child));
}

/**
 * Ticket::unlink(): un padre scollega tutti i figli (e perde FLAG_PARENT/FLAG_LINKED); un figlio si
 * scollega dal padre, che resta padre anche senza altri figli (comportamento PHP).
 */
async function unlinkTicket(ctx: WriteContext, rec: TicketRecord): Promise<void> {
  const { tx } = ctx;
  const isChild = !!rec.get("ticket_pid");
  const isParent = isParentFlags(rec.get("flags"));
  const parent = isParent ? rec : await TicketRecord.load(tx, isChild ? rec.get("ticket_pid")! : rec.id, true);
  if (!parent) return;
  const children = isParent ? await childTickets(tx, rec.id) : [];
  let count = children.length;
  if (children.length) {
    for (const c of children) {
      const child = await TicketRecord.load(tx, c.ticket_id, true);
      if (!child) continue;
      await unlinkChild(ctx, child, parent);
      count--;
    }
  } else if (isChild) {
    await unlinkChild(ctx, rec, parent);
  }
  if (isParent && count === 0) {
    parent.set("flags", parent.get("flags") & ~TicketFlag.LINKED & ~TicketFlag.PARENT);
    await parent.save();
  }
}

/** ajax updateMerge con `dtids[]`: scollegamento dei ticket indicati (per id). */
export async function unlinkTickets(ctx: WriteContext, input: { ticketIds: number[] }): Promise<EditResult> {
  const { tx, agent } = ctx;
  if (!agent) return { error: "denied" };
  for (const id of input.ticketIds) {
    const t = await loadTicket(id, agent.id, tx);
    if (!t || !(await checkStaffPerm(t, agent, undefined, tx))) return { error: "not_found" };
    if (!(await checkStaffPerm(t, agent, TicketPerm.LINK, tx)) && !(await checkStaffPerm(t, agent, TicketPerm.MERGE, tx))) return { error: "denied" };
  }
  for (const id of input.ticketIds) {
    const rec = await TicketRecord.load(tx, id, true);
    if (rec) await unlinkTicket(ctx, rec);
  }
  return { ok: true };
}

/** Ticket::manageMerge (ramo tids): collegamento/unione dei ticket nell'ordine indicato. */
async function manageMerge(ctx: WriteContext, input: MergeInput, ids: number[]): Promise<number[]> {
  const { tx } = ctx;
  const eventName = input.title === "link" ? "linked" : "merged";
  const combine = input.combine;
  const isLink = String(combine) === "2";
  let parentId = 0;
  let changeParent = false;
  for (const [key, id] of ids.entries()) {
    let ticket = (await TicketRecord.load(tx, id, true))!;
    if (key === 0) parentId = ticket.id;
    let parent = (await TicketRecord.load(tx, parentId, true))!;
    const isChild = (r: TicketRecord) => !!r.get("ticket_pid");
    const visual = (r: TicketRecord) => mergeTypeOf(r.get("flags")) === "visual";
    // da link a merge, o cambio del padre di un link
    if (((isParentFlags(ticket.get("flags")) || isChild(ticket)) && visual(ticket) && !isLink) || (isLink && !isParentFlags(parent.get("flags")) && isChild(parent))) {
      await unlinkTicket(ctx, ticket);
      changeParent = true;
      ticket = (await TicketRecord.load(tx, id, true))!;
      parent = (await TicketRecord.load(tx, parentId, true))!;
    }
    if (visual(ticket)) {
      ticket.set("sort", key);
      await ticket.save();
      if (ticket.id === parent.id) parent = (await TicketRecord.load(tx, parentId, true))!;
    }
    if (parent.id !== ticket.id) {
      if (changeParent || (isParentFlags(parent.get("flags")) && visual(ticket) && !isChild(ticket)) || (!isParentFlags(parent.get("flags")) && !isChild(ticket))) {
        await logEvent(ctx, parent, eventName, eventData(ticket));
        await logEvent(ctx, ticket, eventName, eventData(parent));
        if (ticket.get("ticket_pid") !== parent.id) setPid(ticket, parent.id);
        await setMergeType(parent, combine, true);
        await setMergeType(ticket, combine);
        if (parent.get("dept_id") !== ticket.get("dept_id") && !isLink) {
          await threadRefer(tx, await threadIdOf(tx, parent.id), "D", ticket.get("dept_id"));
          await logEvent(ctx, parent, "referred", { dept: ticket.get("dept_id") });
        }
      }
    } else if (isParentFlags(parent.get("flags")) && !visual(ticket)) {
      await setMergeType(parent, combine, true);
    }
  }
  return ids;
}

/**
 * Thread::setExtra($mergedThread) + ThreadEntry::setExtra: le voci del thread del figlio passano nel
 * thread del padre con FLAG_CHILD e una riga thread_entry_merge `{"thread":<thread del figlio>}`
 * (se manca); ogni voce salvata viene reindicizzata (Signal model.updated); il thread del figlio
 * diventa di tipo 'C' con `extra = {"ticket_id":<padre>,"number":"<numero del figlio>"}`.
 */
async function moveThreadEntries(tx: DbOrTx, fromThread: { id: number; object_id: number }, toThreadId: number, parentTicketId: number, number?: string): Promise<void> {
  const entries = await tx.selectFrom("thread_entry").select(["id", "flags", "staff_id", "user_id", "body", "format", "title"]).where("thread_id", "=", fromThread.id).orderBy("created").orderBy("id").execute();
  for (const e of entries) {
    const info = await tx.selectFrom("thread_entry_merge").select("thread_entry_id").where("thread_entry_id", "=", e.id).executeTakeFirst();
    if (!info) await tx.insertInto("thread_entry_merge").values({ thread_entry_id: e.id, data: phpJsonEncode({ thread: fromThread.id }) }).execute();
    await tx.updateTable("thread_entry").set({ flags: e.flags | EntryFlag.CHILD, thread_id: toThreadId }).where("id", "=", e.id).execute();
    if (e.staff_id || e.user_id) await replaceSearchRow(tx, "H", e.id, bodySearchable(e.body, e.format === "text" ? "text" : "html"), e.title ?? "");
  }
  const num = number ?? (await tx.selectFrom("ticket").select("number").where("ticket_id", "=", fromThread.object_id).executeTakeFirst())?.number ?? null;
  await tx
    .updateTable("thread")
    .set({ object_type: "C", extra: phpJsonEncode({ ticket_id: parentTicketId, number: num }) })
    .where("id", "=", fromThread.id)
    .execute();
}

/**
 * Ticket::merge($_POST) (ajax updateMerge con `tids[]`). Restituisce l'esito; per i link il PHP
 * risponde 404 anche quando il collegamento riesce (qui ok).
 */
export async function mergeTickets(ctx: WriteContext, input: MergeInput): Promise<EditResult & { parentId?: number }> {
  const { tx, agent } = ctx;
  if (!agent) return { error: "denied" };
  const perm = input.title === "link" ? TicketPerm.LINK : TicketPerm.MERGE;
  const ids: number[] = [];
  for (const number of input.numbers) {
    const row = await tx.selectFrom("ticket").select("ticket_id").where("number", "=", number).executeTakeFirst();
    // Ticket::lookupByNumber: i numeri non trovati sono ignorati
    if (!row) continue;
    const t = await loadTicket(row.ticket_id, agent.id, tx);
    if (!t || !(await checkStaffPerm(t, agent, undefined, tx))) return { error: "not_found" };
    if (!(await checkStaffPerm(t, agent, perm, tx))) return { error: "denied" };
    ids.push(row.ticket_id);
  }
  if (!ids.length) return { error: "no_tickets" };

  await manageMerge(ctx, input, ids);

  // Ticket::merge: padre = l'ultimo ticket con FLAG_PARENT, figli = tutti gli altri
  let parent: TicketRecord | null = null;
  const children: TicketRecord[] = [];
  for (const id of ids) {
    const r = (await TicketRecord.load(tx, id, true))!;
    if (isParentFlags(r.get("flags"))) parent = r;
    else children.push(r);
  }
  if (!parent || mergeTypeOf(parent.get("flags")) === "visual") return { ok: true, parentId: parent?.id };

  const parentThreadId = await threadIdOf(tx, parent.id);
  for (let child of children) {
    if (input.participants === "all") {
      const collabs = await tx
        .selectFrom("thread_collaborator as c")
        .innerJoin("user as u", "u.id", "c.user_id")
        .select("c.user_id")
        .where("c.thread_id", "=", await threadIdOf(tx, child.id))
        .orderBy("u.name")
        .execute();
      for (const c of collabs) {
        if (c.user_id !== parent.get("user_id")) await addTicketCollaborator(ctx, parent.row, parentThreadId, c.user_id, true);
      }
    }
    if (child.get("user_id") !== parent.get("user_id")) {
      // Il proprietario del figlio è un TicketOwner: logCollaboratorEvents usa `user_id` (vuoto) come chiave
      await addOwnerAsCollaborator(ctx, parent, parentThreadId, child.get("user_id"));
    }

    // Thread di ticket già uniti in precedenza al figlio (nipoti): puntano ora al padre
    const grand = await tx
      .selectFrom("thread")
      .select(["id", "object_id", "extra"])
      .where("extra", "like", `%"ticket_id":${child.id}%`)
      .orderBy("id")
      .executeTakeFirst();
    if (grand) {
      const extra = JSON.parse(grand.extra ?? "{}") as { number?: string };
      await moveThreadEntries(tx, grand, parentThreadId, parent.id, extra.number || undefined);
    }
    const childThread = await ticketThread(tx, child.id);
    if (childThread) await moveThreadEntries(tx, { id: childThread.id, object_id: child.id }, parentThreadId, parent.id);

    await setMergeType(child, input.combine);
    // Stato di chiusura del figlio (chiusura forzata, nessun commento)
    if (input.childStatusId) {
      await setTicketStatus(ctx, child, await threadIdOf(tx, child.id), input.childStatusId, { setClosingAgent: true, forceClose: true });
    }
    if (input.parentStatusId) {
      parent = (await TicketRecord.load(tx, parent.id, true))!;
      await setTicketStatus(ctx, parent, parentThreadId, input.parentStatusId);
    }
    if (input.deleteChild || input.moveTasks) {
      // Task::objects()->filter(object_id = figlio): senza filtro sul tipo di oggetto (come il PHP)
      await tx.updateTable("task").set({ object_id: parent.id }).where("object_id", "=", child.id).execute();
    }
    if (input.deleteChild) {
      child = (await TicketRecord.load(tx, child.id, true))!;
      await deleteTicket(ctx, child, "");
    }
  }
  return { ok: true, parentId: parent.id };
}

/** Proprietario del figlio aggiunto al padre: evento collab con chiave vuota (TicketOwner::user_id). */
async function addOwnerAsCollaborator(ctx: WriteContext, parent: TicketRecord, threadId: number, userId: number): Promise<void> {
  const r = await addTicketCollaborator(ctx, parent.row, threadId, userId, false);
  if ("error" in r) return;
  const u = await ctx.tx.selectFrom("user").select("name").where("id", "=", userId).executeTakeFirst();
  await logTicketEvent(ctx.tx, parent.row, threadId, ctx.actor, "collab", { add: { "": { name: u?.name ?? "" } } });
}

/** Ticket collegati/uniti (padre e figli) per la vista ticket. */
export async function relatedTickets(executor: DbOrTx, ticketId: number) {
  const t = await executor.selectFrom("ticket").select(["ticket_id", "ticket_pid", "flags"]).where("ticket_id", "=", ticketId).executeTakeFirst();
  if (!t) return null;
  const parentId = t.ticket_pid ?? (isParentFlags(t.flags) ? t.ticket_id : null);
  if (!parentId) return { parentId: null, mergeType: mergeTypeOf(t.flags), tickets: [] };
  const rows = await executor
    .selectFrom("ticket as t")
    .leftJoin("ticket__cdata as c", "c.ticket_id", "t.ticket_id")
    .select(["t.ticket_id", "t.number", "t.ticket_pid", "t.flags", "t.sort", "c.subject"])
    .where((eb) => eb.or([eb("t.ticket_id", "=", parentId), eb("t.ticket_pid", "=", parentId)]))
    .orderBy("t.sort")
    .orderBy("t.ticket_id")
    .execute();
  const parent = rows.find((r) => r.ticket_id === parentId);
  return {
    parentId,
    mergeType: mergeTypeOf(parent?.flags ?? t.flags),
    tickets: rows.map((r) => ({ id: r.ticket_id, number: r.number ?? "", subject: r.subject ?? "", parent: r.ticket_id === parentId, mergeType: mergeTypeOf(r.flags) })),
  };
}
