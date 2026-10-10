import "server-only";

import { Collaborator } from "@/lib/osticket/flags";

import { NOW } from "../../db";
import { PersonsName } from "../../format/persons-name";
import type { EntryRecipients } from "../thread/write";
import type { WriteContext } from "./context";
import { lookupUser, userEmail } from "./create-user";
import { logTicketEvent } from "./events";
import type { TicketRecord } from "./record";

/**
 * Collaboratori e destinatari del ticket in creazione (include/class.ticket.php, class.thread.php):
 * Ticket::addCollaborator, Ticket::getRecipients e il formato `recipients` della voce del thread.
 */

/** Contatti di Ticket::getRecipients($who, $whitelist) con ids come MailingList::getEmailAddresses */
export async function ticketRecipients(ctx: WriteContext, ownerId: number, threadId: number, who: string, whitelist?: number[]) {
  const nameOf = (name: string, email: string) => new PersonsName(name || email.split("@")[0], ctx.cfg.str("client_name_format")).toString();
  const to: { listId: number; userId: number; name: string; email: string }[] = [];
  const cc: { listId: number; userId: number; name: string; email: string }[] = [];
  const w = who.toLowerCase();
  if (!["user", "all", "collabs"].includes(w)) return null;
  const contact = async (uid: number) =>
    ctx.tx
      .selectFrom("user as u")
      .leftJoin("user_email as e", "e.id", "u.default_email_id")
      .select(["u.id", "u.name", "e.address"])
      .where("u.id", "=", uid)
      .executeTakeFirst();
  if (w === "user" || w === "all") {
    const o = await contact(ownerId);
    if (o) to.push({ listId: o.id, userId: o.id, name: nameOf(o.name, o.address ?? ""), email: o.address ?? "" });
  }
  if (w === "all" || w === "collabs") {
    // Thread::getCollaborators: order_by('user__name')
    const collabs = await ctx.tx
      .selectFrom("thread_collaborator as c")
      .innerJoin("user as u", "u.id", "c.user_id")
      .select(["c.id", "c.user_id", "c.flags"])
      .where("c.thread_id", "=", threadId)
      .orderBy("u.name")
      .orderBy("c.id")
      .execute();
    for (const c of collabs) {
      if (!(c.flags & Collaborator.ACTIVE)) continue;
      if (whitelist?.length && !whitelist.includes(c.user_id)) continue;
      const u = await contact(c.user_id);
      if (u) cc.push({ listId: c.id, userId: c.user_id, name: nameOf(u.name, u.address ?? ""), email: u.address ?? "" });
    }
  }
  return { to, cc };
}

export function recipientsJson(r: { to: { listId: number; name: string; email: string }[]; cc: { listId: number; name: string; email: string }[] }): EntryRecipients {
  const out: EntryRecipients = {};
  for (const [k, list] of [["to", r.to], ["cc", r.cc]] as const) {
    if (!list.length) continue;
    out[k] = list.map((c): [string, string] => [String(c.listId), `${c.name} <${c.email}>`]);
  }
  return out;
}

/** Thread::addCollaborator + Ticket::addCollaborator (flag ACTIVE|CC) con evento collab */
export async function addCollaborator(ctx: WriteContext, rec: TicketRecord, threadId: number, userId: number, logEvent = true): Promise<boolean> {
  if (userId === rec.get("user_id")) return false;
  const exists = await ctx.tx.selectFrom("thread_collaborator").select("id").where("thread_id", "=", threadId).where("user_id", "=", userId).executeTakeFirst();
  if (exists) return false;
  const user = await lookupUser(ctx.tx, userId);
  if (!user) return false;
  let flags = Collaborator.ACTIVE | Collaborator.CC;
  // disable_agent_collabs per i ticket creati dai clienti: collaboratore inattivo se l'email è di un agente
  if (!ctx.agent && ctx.cfg.bool("disable_agent_collabs")) {
    const email = await userEmail(ctx.tx, user);
    const staff = email ? await ctx.tx.selectFrom("staff").select("staff_id").where("email", "=", email).executeTakeFirst() : undefined;
    if (staff) flags = Collaborator.CC;
  }
  await ctx.tx.insertInto("thread_collaborator").values({ flags, thread_id: threadId, user_id: userId, role: "M", created: NOW, updated: NOW }).execute();
  if (logEvent) await logTicketEvent(ctx.tx, rec.row, threadId, ctx.actor, "collab", { add: { [String(userId)]: { name: user.name } } });
  return true;
}
