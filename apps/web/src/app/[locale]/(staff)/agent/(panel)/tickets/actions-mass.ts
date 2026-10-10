"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { formFlag, formHtml, formIds, formNum, formStr, formStrs } from "@/server/actions/form-data";
import { clientIp } from "@/server/auth/session";
import { currentAgent } from "@/server/auth/staff-auth";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { adhocListQueue, type AdhocListParams } from "@/server/domain/queue/queues";
import { activeTeams } from "@/server/domain/ticket/assignees";
import type { WriteContext } from "@/server/domain/ticket/context";
import { exportQueueCsv } from "@/server/domain/ticket/export";
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
import { agentTimeZone } from "@/server/format/datetime";

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

const tidsOf = (form: FormData) => [...new Set(formIds(form, "tids"))];

async function run(fn: (ctx: WriteContext) => Promise<MassResult>): Promise<MassActionState> {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired", nonce: Date.now() };
  const r = await runWrite({ agent, ip: await clientIp() }, fn);
  if ("error" in r) return { error: r.error, nonce: Date.now() };
  revalidatePath("/", "layout");
  return { ok: true, count: r.count, total: r.total, nonce: Date.now() };
}

export async function massAssignAction(_prev: MassActionState, form: FormData): Promise<MassActionState> {
  const assignee = formStr(form, "assignee");
  if (!/^[st]\d+$/.test(assignee)) return { error: "assignee_required", nonce: Date.now() };
  return run((ctx) => massAssign(ctx, { ticketIds: tidsOf(form), assignee, comments: formHtml(form) }));
}

export async function massClaimAction(_prev: MassActionState, form: FormData): Promise<MassActionState> {
  return run((ctx) => massClaim(ctx, { ticketIds: tidsOf(form), comments: formHtml(form) }));
}

export async function massTransferAction(_prev: MassActionState, form: FormData): Promise<MassActionState> {
  const deptId = formNum(form, "dept");
  if (!deptId) return { error: "dept_required", nonce: Date.now() };
  return run((ctx) => massTransfer(ctx, { ticketIds: tidsOf(form), deptId, comments: formHtml(form) }));
}

export async function massDeleteAction(_prev: MassActionState, form: FormData): Promise<MassActionState> {
  return run((ctx) => massDelete(ctx, { ticketIds: tidsOf(form), comments: formStr(form, "comments") }));
}

export async function massStatusAction(_prev: MassActionState, form: FormData): Promise<MassActionState> {
  // setSelectedTicketsStatus passa $_REQUEST['comments'] grezzo (pulito da ThreadEntryBody)
  const comments = formHtml(form, "comments", { sanitize: false });
  return run((ctx) => massChangeStatus(ctx, { ticketIds: tidsOf(form), statusId: formNum(form, "statusId"), comments }));
}

/** Merge/link dei ticket scelti: ordine dal dialogo (il primo è il padre), poi Ticket::merge. */
export async function massMergeAction(_prev: MassActionState, form: FormData): Promise<MassActionState> {
  const title = form.get("title") === "link" ? "link" : "merge";
  const numbers = formStrs(form, "numbers").filter(Boolean);
  if (numbers.length < 2) return { error: "select_two", nonce: Date.now() };
  return run(async (ctx) => {
    const r = await mergeTickets(ctx, {
      title,
      numbers,
      combine: title === "link" ? "2" : formStr(form, "combine", "1"),
      participants: formStr(form, "participants", "all"),
      childStatusId: formNum(form, "childStatusId") || undefined,
      parentStatusId: formNum(form, "parentStatusId") || undefined,
      deleteChild: formFlag(form, "deleteChild"),
      moveTasks: formFlag(form, "moveTasks"),
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

/**
 * Export CSV di una ricerca ad hoc (ajax.php/tickets/export/adhoc,<chiave> → CustomQueue::export): la
 * ricerca è ricostruita dai parametri della lista; il file torna al browser come testo.
 */
export async function exportAdhocAction(
  adhoc: AdhocListParams,
  opts: { fields: string[]; delimiter: string; sort?: string; dir?: string },
): Promise<{ filename: string; content: string } | { error: string }> {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired" };
  const t = await getTranslations("tickets");
  const queue = adhocListQueue(agent, adhoc, {
    user: t("userTickets"),
    org: t("orgTickets"),
  });
  if (!queue) return { error: "not_found" };
  return exportQueueCsv(db(), await coreConfig(), agent, queue, {
    fields: opts.fields.length ? opts.fields : undefined,
    delimiter: [",", ";", "\t", "|"].includes(opts.delimiter) ? opts.delimiter : ",",
    sort: opts.sort,
    dir: opts.dir === "1" ? 1 : 0,
    userTz: await agentTimeZone(agent),
  });
}
