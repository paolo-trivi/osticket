"use server";

import { revalidatePath } from "next/cache";

import { currentAgent } from "@/server/auth/staff-auth";
import { clientIp } from "@/server/auth/session";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { TicketPerm } from "@/server/domain/staff/staff";
import { deleteDraftsFor, isEmailBanned, syncActiveCollaborators } from "@/server/domain/ticket/collab";
import { acquireTicketLock, checkLockForPost, releaseTicketLock, renewTicketLock } from "@/server/domain/ticket/lock";
import { postNote, postReply, ticketThreadId } from "@/server/domain/ticket/post";
import { statusState } from "@/server/domain/ticket/record";
import { checkStaffPerm, loadTicket, roleOn } from "@/server/domain/ticket/ticket";
import { runWrite } from "@/server/domain/write";

export interface PostState {
  ok?: boolean;
  error?: string;
  /** il ticket è stato chiuso: la UI torna alla lista */
  closed?: boolean;
  nonce?: number;
}

async function loadForWrite(ticketId: number) {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired" as const };
  const ticket = await loadTicket(ticketId, agent.id);
  if (!ticket || !(await checkStaffPerm(ticket, agent))) return { error: "not_found" as const };
  return { agent, ticket };
}

export async function postReplyAction(_prev: PostState, form: FormData): Promise<PostState> {
  const ticketId = Number(form.get("ticketId"));
  const loaded = await loadForWrite(ticketId);
  if ("error" in loaded) return { error: loaded.error };
  const { agent, ticket } = loaded;
  if (!roleOn(ticket, agent).perms.has(TicketPerm.REPLY)) return { error: "denied" };

  const response = String(form.get("response") ?? "");
  if (!response.replace(/<[^>]*>|&nbsp;|\s/g, "")) return { error: "response_required" };
  const cfg = await coreConfig();
  const lockError = await checkLockForPost(db(), cfg, ticketId, agent.id, String(form.get("lockCode") ?? ""));
  if (lockError) return { error: lockError };
  if (await isEmailBanned(db(), ticket.user_email ?? "")) return { error: "banned" };

  const replyTo = String(form.get("replyTo") ?? "all");
  const ccs = form.getAll("ccs").map(Number).filter(Boolean);
  const statusId = Number(form.get("statusId") ?? 0) || undefined;
  const signature = (String(form.get("signature") ?? "none") as "none" | "mine" | "dept") || "none";

  const result = await runWrite({ agent, ip: await clientIp() }, async (ctx) => {
    const threadId = await ticketThreadId(ctx.tx, ticketId);
    await syncActiveCollaborators(ctx.tx, threadId, ccs);
    const r = await postReply(ctx, { ticketId, response, replyTo, ccs, statusId, signature, alert: replyTo !== "none" });
    if ("error" in r) return r;
    await releaseTicketLock(ctx.tx, ticketId, agent.id);
    await deleteDraftsFor(ctx.tx, `ticket.response.${ticketId}`, agent.id);
    const row = await ctx.tx.selectFrom("ticket").select("status_id").where("ticket_id", "=", ticketId).executeTakeFirstOrThrow();
    return { ...r, closed: (await statusState(ctx.tx, row.status_id)) === "closed" };
  });
  if ("error" in result) return { error: result.error };
  revalidatePath(`/agent/tickets/${ticketId}`);
  return { ok: true, closed: result.closed, nonce: Date.now() };
}

export async function postNoteAction(_prev: PostState, form: FormData): Promise<PostState> {
  const ticketId = Number(form.get("ticketId"));
  const loaded = await loadForWrite(ticketId);
  if ("error" in loaded) return { error: loaded.error };
  const { agent } = loaded;
  const note = String(form.get("note") ?? "");
  if (!note.replace(/<[^>]*>|&nbsp;|\s/g, "")) return { error: "note_required" };
  const cfg = await coreConfig();
  const lockError = await checkLockForPost(db(), cfg, ticketId, agent.id, String(form.get("lockCode") ?? ""));
  if (lockError) return { error: lockError };

  const title = String(form.get("title") ?? "");
  const statusId = Number(form.get("statusId") ?? 0) || undefined;
  const result = await runWrite({ agent, ip: await clientIp() }, async (ctx) => {
    const before = await ctx.tx.selectFrom("ticket").select("status_id").where("ticket_id", "=", ticketId).executeTakeFirstOrThrow();
    const wasOpen = (await statusState(ctx.tx, before.status_id)) === "open";
    const r = await postNote(ctx, { ticketId, note, title, statusId });
    if ("error" in r) return r;
    await releaseTicketLock(ctx.tx, ticketId, agent.id);
    const row = await ctx.tx.selectFrom("ticket").select("status_id").where("ticket_id", "=", ticketId).executeTakeFirstOrThrow();
    const closed = (await statusState(ctx.tx, row.status_id)) === "closed";
    if (!(wasOpen && closed)) await deleteDraftsFor(ctx.tx, `ticket.note.${ticketId}`, agent.id);
    return { ...r, closed: wasOpen && closed };
  });
  if ("error" in result) return { error: result.error };
  revalidatePath(`/agent/tickets/${ticketId}`);
  return { ok: true, closed: result.closed, nonce: Date.now() };
}

export interface LockState {
  id: number;
  code?: string;
  time?: number;
  lockedBy?: string;
}

/** Equivalente di ajax.php/lock/ticket/<id> (acquisizione o rinnovo). */
export async function lockAction(ticketId: number, lockId?: number): Promise<LockState> {
  const loaded = await loadForWrite(ticketId);
  if ("error" in loaded) return { id: 0 };
  const cfg = await coreConfig();
  const res = await db()
    .transaction()
    .execute((tx) => (lockId ? renewTicketLock(tx, cfg, ticketId, lockId, loaded.agent.id) : acquireTicketLock(tx, cfg, ticketId, loaded.agent.id)));
  if (res.ok) return { id: res.lock.lock_id, code: res.lock.code ?? "", time: res.lock.time };
  if (res.lockedBy) {
    const s = await db().selectFrom("staff").select(["firstname", "lastname"]).where("staff_id", "=", res.lockedBy).executeTakeFirst();
    return { id: 0, lockedBy: s ? `${s.firstname} ${s.lastname}` : "?" };
  }
  return { id: 0 };
}

export async function releaseLockAction(ticketId: number): Promise<void> {
  const agent = await currentAgent();
  if (!agent) return;
  await db().transaction().execute((tx) => releaseTicketLock(tx, ticketId, agent.id));
}

/** Testo di una risposta predefinita con le variabili del ticket sostituite (ajax canned). */
export async function cannedTextAction(ticketId: number, cannedId: number): Promise<string> {
  const loaded = await loadForWrite(ticketId);
  if ("error" in loaded) return "";
  const { renderCannedForTicket } = await import("@/server/domain/kb/canned-render");
  return renderCannedForTicket(cannedId, ticketId, loaded.agent);
}
