"use server";

import { revalidatePath } from "next/cache";

import { clientIp } from "@/server/auth/session";
import { currentAgent } from "@/server/auth/staff-auth";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { activeTeams } from "@/server/domain/ticket/assign";
import type { WriteContext } from "@/server/domain/ticket/context";
import { mergeTickets } from "@/server/domain/ticket/merge";
import {
  massAssign,
  massAssignableAgents,
  massChangeStatus,
  massClaim,
  massDelete,
  massMergeCandidates,
  massTransfer,
  type MassResult,
} from "@/server/domain/ticket/mass";
import { runWrite } from "@/server/domain/write";
import { sanitizeText } from "@/server/format/text";

/**
 * Server action delle azioni di massa della lista ticket (area "ticketedit"): ajax.tickets.php
 * massProcess e setSelectedTicketsStatus. I ticket scelti arrivano nei campi `tids`.
 */

export interface MassActionState {
  ok?: boolean;
  error?: string;
  count?: number;
  total?: number;
  nonce?: number;
}

const tidsOf = (form: FormData) => [...new Set(form.getAll("tids").map(Number).filter(Boolean))];

function comments(form: FormData): string {
  const raw = String(form.get("comments") ?? "");
  if (!raw.replace(/<[^>]*>|&nbsp;|\s/g, "")) return "";
  return sanitizeText(raw);
}

async function run(fn: (ctx: WriteContext) => Promise<MassResult>): Promise<MassActionState> {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired", nonce: Date.now() };
  const r = await runWrite({ agent, ip: await clientIp() }, fn);
  if ("error" in r) return { error: r.error, nonce: Date.now() };
  revalidatePath("/", "layout");
  return { ok: true, count: r.count, total: r.total, nonce: Date.now() };
}

export async function massAssignAction(_prev: MassActionState, form: FormData): Promise<MassActionState> {
  const assignee = String(form.get("assignee") ?? "");
  if (!/^[st]\d+$/.test(assignee)) return { error: "assignee_required", nonce: Date.now() };
  return run((ctx) => massAssign(ctx, { ticketIds: tidsOf(form), assignee, comments: comments(form) }));
}

export async function massClaimAction(_prev: MassActionState, form: FormData): Promise<MassActionState> {
  return run((ctx) => massClaim(ctx, { ticketIds: tidsOf(form), comments: comments(form) }));
}

export async function massTransferAction(_prev: MassActionState, form: FormData): Promise<MassActionState> {
  const deptId = Number(form.get("dept") ?? 0);
  if (!deptId) return { error: "dept_required", nonce: Date.now() };
  return run((ctx) => massTransfer(ctx, { ticketIds: tidsOf(form), deptId, comments: comments(form) }));
}

export async function massDeleteAction(_prev: MassActionState, form: FormData): Promise<MassActionState> {
  return run((ctx) => massDelete(ctx, { ticketIds: tidsOf(form), comments: String(form.get("comments") ?? "") }));
}

export async function massStatusAction(_prev: MassActionState, form: FormData): Promise<MassActionState> {
  // setSelectedTicketsStatus passa $_REQUEST['comments'] grezzo (pulito da ThreadEntryBody)
  const raw = String(form.get("comments") ?? "");
  return run((ctx) =>
    massChangeStatus(ctx, { ticketIds: tidsOf(form), statusId: Number(form.get("statusId") ?? 0), comments: raw.replace(/<[^>]*>|&nbsp;|\s/g, "") ? raw : "" }),
  );
}

/** Merge/link dei ticket scelti: ordine dal dialogo (il primo è il padre), poi Ticket::merge. */
export async function massMergeAction(_prev: MassActionState, form: FormData): Promise<MassActionState> {
  const title = form.get("title") === "link" ? "link" : "merge";
  const numbers = form.getAll("numbers").map(String).filter(Boolean);
  if (numbers.length < 2) return { error: "select_two", nonce: Date.now() };
  return run(async (ctx) => {
    const r = await mergeTickets(ctx, {
      title,
      numbers,
      combine: title === "link" ? "2" : String(form.get("combine") ?? "1"),
      participants: String(form.get("participants") ?? "all"),
      childStatusId: Number(form.get("childStatusId") ?? 0) || undefined,
      parentStatusId: Number(form.get("parentStatusId") ?? 0) || undefined,
      deleteChild: form.get("deleteChild") === "1",
      moveTasks: form.get("moveTasks") === "1",
    });
    return "error" in r ? { error: r.error } : { ok: true, count: numbers.length, total: numbers.length };
  });
}

/** massProcess merge|link (GET): verifica dei ticket scelti e ordine proposto. */
export async function massMergeCandidatesAction(ids: number[], title: "merge" | "link") {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired" };
  return massMergeCandidates(db(), agent, ids, title);
}

/** massProcess assign/agents|teams (GET): assegnatari proposti per i ticket scelti. */
export async function massAssigneesAction(ids: number[], what: "agents" | "teams") {
  const agent = await currentAgent();
  if (!agent) return [];
  if (what === "teams") return (await activeTeams(db())).map((t) => ({ value: `t${t.id}`, label: t.name }));
  const cfg = await coreConfig();
  return (await massAssignableAgents(db(), agent, ids, cfg.str("agent_name_format"))).map((a) => ({ value: `s${a.id}`, label: a.name }));
}
