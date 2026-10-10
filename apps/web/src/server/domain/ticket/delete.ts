import "server-only";

import { sql } from "kysely";

import { FormType, ObjectType } from "@/lib/osticket/object-types";

import { table, type DbOrTx } from "../../db";
import { sanitizeText } from "../../format/text";
import { deleteSearchRow } from "../search/index-writer";
import { logSystem } from "../../system/syslog";
import { ticketThread } from "../thread/ids";
import type { WriteContext } from "./context";
import { logTicketEvent } from "./events";
import { childTickets, isParentFlags, setMergeType, setPid } from "./merge-flags";
import { TicketRecord } from "./record";
import { deleteTicketDrafts, roleOnRow, setTicketStatus, stateOf } from "./status";
import type { TicketHardDelete } from "./ticket-state";
import { TicketPerm } from "../staff/staff";

/**
 * Eliminazione definitiva di un ticket (Ticket::delete, include/class.ticket.php:3601) e del suo
 * thread (Thread::delete, include/class.thread.php:743), nello stesso ordine del PHP:
 *  1. DELETE ticket (+ Signal model.deleted → riga `_search` T);
 *  2. ticket padre: i figli tornano ticket normali (ticket_pid NULL, flag di merge azzerati) e il
 *     loro thread torna di tipo 'T';
 *  3. ticket figlio: se il padre non ha più figli torna un ticket normale; il thread NON viene
 *     eliminato (comportamento PHP); altrimenti Thread::delete:
 *     - DELETE thread (+ righe `_search` H delle voci, cancellate prima delle voci);
 *     - thread_entry_email.headers = NULL;
 *     - allegati delle voci (attachment di tipo H) e, se ne è stato rimosso almeno uno,
 *       AttachmentFile::deleteOrphans (file 'T' senza allegati creati da più di un giorno, in tutto il DB);
 *     - collaboratori, referral, voci del thread;
 *     - thread_event.thread_id = 0 per gli eventi esistenti;
 *  4. evento "deleted" registrato sul thread (ormai eliminato: il PHP usa ancora il suo id);
 *  5. form_entry del ticket e relative risposte; bozze `ticket.%.<id>`; riga ticket__cdata;
 *  6. syslog Debug "Ticket #N deleted" (solo con log_level 3).
 * Il lock del ticket (tabella `lock`) non viene rimosso: il PHP non lo tocca.
 */
export async function deleteTicket(ctx: WriteContext, rec: TicketRecord, comments = ""): Promise<boolean> {
  const { tx } = ctx;
  const id = rec.id;
  const thread = await ticketThread(tx, id);

  // parent::delete(): DELETE ... LIMIT 1, poi Signal model.deleted (MysqlSearchBackend::delete)
  const del = await sql`DELETE FROM ${table("ticket")} WHERE ticket_id = ${id} LIMIT 1`.execute(tx);
  if (Number(del.numAffectedRows ?? 0) !== 1) return false;
  await deleteSearchRow(tx, "T", id);

  // Ticket padre: i figli tornano indipendenti (Ticket::getChildren solo con FLAG_PARENT)
  if (isParentFlags(rec.get("flags"))) {
    for (const c of await childTickets(tx, id)) {
      const child = await TicketRecord.load(tx, c.ticket_id, true);
      if (!child) continue;
      setPid(child, null);
      await setMergeType(child, 3);
      const childThread = await ticketThread(tx, child.id);
      // $childThread->object_type = 'T'; save() scrive solo se cambia
      if (childThread && childThread.object_type !== ObjectType.TICKET) {
        await tx.updateTable("thread").set({ object_type: ObjectType.TICKET }).where("id", "=", childThread.id).execute();
      }
    }
  }

  if (rec.get("ticket_pid")) {
    // Ticket figlio: il padre senza altri figli torna un ticket normale
    const parent = await TicketRecord.load(tx, rec.get("ticket_pid")!, true);
    if (parent && isParentFlags(parent.get("flags")) && (await childTickets(tx, parent.id)).length === 0) {
      await setMergeType(parent, 3);
    }
  } else if (thread) {
    await deleteThread(tx, thread.id);
  }

  if (thread) await logTicketEvent(tx, rec.row, thread.id, ctx.actor, "deleted");

  // DynamicFormEntry::delete: la riga dell'entry e poi le risposte una per una
  const entries = await tx.selectFrom("form_entry").select("id").where("object_type", "=", FormType.TICKET).where("object_id", "=", id).orderBy("sort").orderBy("id").execute();
  for (const e of entries) {
    await tx.deleteFrom("form_entry").where("id", "=", e.id).execute();
    await tx.deleteFrom("form_entry_values").where("entry_id", "=", e.id).execute();
  }

  await deleteTicketDrafts(tx, id);
  await tx.deleteFrom("ticket__cdata" as never).where("ticket_id" as never, "=", id as never).execute();

  const by = ctx.actor?.kind === "staff" ? ctx.actor.name : "SYSTEM";
  let log = `Ticket #${rec.get("number")} deleted by ${by}`;
  if (comments) log += `<hr>${comments}`;
  await logSystem("Debug", `Ticket #${rec.get("number")} deleted`, sanitizeText(log), ctx.actor?.ip ?? "", { executor: tx });
  return true;
}

/** Thread::delete (include/class.thread.php:743) per il thread indicato. */
async function deleteThread(tx: DbOrTx, threadId: number): Promise<boolean> {
  const del = await sql`DELETE FROM ${table("thread")} WHERE id = ${threadId} LIMIT 1`.execute(tx);
  if (Number(del.numAffectedRows ?? 0) !== 1) return false;
  // Signal model.deleted → MysqlSearchBackend::delete(Thread): righe H delle voci del thread
  await sql`DELETE s.* FROM ${table("_search")} s JOIN ${table("thread_entry")} h ON (h.id = s.object_id)
    WHERE s.object_type = 'H' AND h.thread_id = ${threadId}`.execute(tx);
  await sql`UPDATE ${table("thread_entry_email")} E JOIN ${table("thread_entry")} H ON (H.id = E.thread_entry_id)
    SET E.headers = NULL WHERE H.thread_id = ${threadId}`.execute(tx);
  await deleteThreadAttachments(tx, threadId);
  await tx.deleteFrom("thread_collaborator").where("thread_id", "=", threadId).execute();
  await tx.deleteFrom("thread_referral").where("thread_id", "=", threadId).execute();
  await tx.deleteFrom("thread_entry").where("thread_id", "=", threadId).execute();
  await tx.updateTable("thread_event").set({ thread_id: 0 }).where("thread_id", "=", threadId).execute();
  return true;
}

/** Thread::deleteAttachments: allegati delle voci del thread, poi i file orfani. */
async function deleteThreadAttachments(tx: DbOrTx, threadId: number): Promise<number> {
  const res = await sql`DELETE A FROM ${table("attachment")} A JOIN ${table("thread_entry")} H ON (A.type = 'H' AND A.object_id = H.id)
    WHERE H.thread_id = ${threadId}`.execute(tx);
  const deleted = Number(res.numAffectedRows ?? 0);
  if (deleted) await deleteOrphanFiles(tx);
  return deleted;
}

/**
 * AttachmentFile::deleteOrphans: file di tipo 'T' senza allegati, creati da più di un giorno; per
 * ognuno DELETE file e i dati del backend ($bk->unlink(): file_chunk per il backend "D" nel DB).
 *
 * File con altri backend ("F" su filesystem, plugin): il PHP cancella la riga e poi il contenuto
 * (FilesystemStorage::unlink rimuove `<uploadpath>/<k>/<chiave>`). TailTicket legge la cartella in sola
 * lettura e non può cancellare il file su disco: cancellare solo la riga lascerebbe su disco un file
 * che nessuno ripulirebbe più. La riga quindi resta: è ancora orfana e la cancellerà il PHP
 * (Cron::CleanOrphanedFiles o la prossima eliminazione di un ticket dal pannello PHP) insieme al file.
 * Con file tutti "D" il comportamento è identico al PHP.
 */
async function deleteOrphanFiles(tx: DbOrTx): Promise<void> {
  const { rows } = await sql<{
    id: number;
    bk: string;
  }>`SELECT F.id, F.bk FROM ${table("file")} F
    LEFT JOIN ${table("attachment")} A ON (A.file_id = F.id)
    WHERE A.object_id IS NULL AND F.ft = 'T' AND F.created < (NOW() - INTERVAL 1 DAY)`.execute(tx);
  for (const f of rows) {
    if (f.bk && f.bk !== "D") continue;
    const del = await sql`DELETE FROM ${table("file")} WHERE id = ${f.id} LIMIT 1`.execute(tx);
    if (Number(del.numAffectedRows ?? 0) !== 1) break;
    if (f.bk === "D") await tx.deleteFrom("file_chunk").where("file_id", "=", f.id).execute();
  }
}

/**
 * Aggancio per changeTicketStatus (stato "deleted" = Ticket::delete($comments)).
 *
 * Con `children` (casella "anche ai figli" di ajax setTicketStatus) il PHP elimina poi ogni figlio
 * con `$child->setStatus($status, '')`, usando l'elenco dei figli letto (e messo in cache) da
 * Ticket::delete *prima* di scollegarli. changeTicketStatus invece rilegge i figli dopo l'eliminazione
 * del padre e non li trova più (ticket_pid già azzerato): per questo l'eliminazione dei figli avviene
 * qui, con lo stesso controllo di Ticket::setStatus (permesso ticket.delete sul ruolo del figlio).
 */
export function ticketHardDelete(opts: { children?: boolean } = {}): TicketHardDelete {
  return async (ctx, rec, comments) => {
    const children = opts.children && isParentFlags(rec.get("flags")) ? await childTickets(ctx.tx, rec.id) : [];
    if (!(await deleteTicket(ctx, rec, comments))) return false;
    for (const c of children) {
      const child = await TicketRecord.load(ctx.tx, c.ticket_id, true);
      if (!child) continue;
      if (ctx.agent) {
        const role = roleOnRow(child.row, await stateOf(ctx.tx, child.row), ctx.agent);
        if (!role.perms.has(TicketPerm.DELETE)) continue;
      }
      await deleteTicket(ctx, child, "");
    }
    return true;
  };
}

/**
 * User::deleteAllTickets (include/class.user.php): per ogni ticket dell'utente `setStatus` sullo stato
 * "deleted" (TicketStatus::lookup(state=deleted)), senza commento: con PERM_DELETE diventa Ticket::delete.
 * Restituisce false al primo ticket non eliminabile (permesso mancante), come il PHP.
 */
export async function deleteTicketViaDeletedStatus(ctx: WriteContext, ticketId: number): Promise<boolean> {
  const rec = await TicketRecord.load(ctx.tx, ticketId, true);
  if (!rec) return true;
  const deleted = await ctx.tx.selectFrom("ticket_status").select("id").where("state", "=", "deleted").orderBy("id").executeTakeFirst();
  if (!deleted) return false;
  const thread = await ticketThread(ctx.tx, ticketId);
  const r = await setTicketStatus(ctx, rec, thread?.id ?? 0, deleted.id, { hardDelete: () => deleteTicket(ctx, rec, "") });
  return r === true;
}
