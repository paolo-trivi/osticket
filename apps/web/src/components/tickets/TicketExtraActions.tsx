import { sql } from "kysely";

import { ThreadEntry, Ticket, TicketStatus } from "@/lib/osticket/flags";
import { FormType } from "@/lib/osticket/object-types";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { detectDbTimezone } from "@/server/db/time";
import { loadFormDef } from "@/server/domain/forms/load";
import { GlobalPerm, TicketPerm, type Agent } from "@/server/domain/staff/staff";
import { canEditEntry, entryEditContext } from "@/server/domain/thread/edit";
import { formView, openTicketOptions } from "@/server/domain/ticket/create-ui";
import { dbDateToInput, TICKET_SOURCE_KEYS } from "@/server/domain/ticket/edit-values";
import { relatedTickets } from "@/server/domain/ticket/merge";
import { mergeTypeOf } from "@/server/domain/ticket/merge-flags";
import { emailInBanList } from "@/server/domain/ticket/overdue";
import { ticketStatusChoices } from "@/server/domain/ticket/ticket-state";
import { loadCollaborators, loadThreadEntries, roleOn, type TicketDetail } from "@/server/domain/ticket/ticket";

import TicketExtraMenu from "./edit/TicketExtraMenu";
import type { TicketExtraData } from "./edit/types";

/**
 * Slot della vista ticket per l'area "ticketedit": modifica del ticket e dei singoli campi,
 * proprietario, collaboratori, merge/link, segna come scaduto, ban dell'email, eliminazione,
 * modifica delle voci del thread. Le voci seguono le condizioni di include/staff/ticket-view.inc.php.
 */
export default async function TicketExtraActions({ ticket, agent }: { ticket: TicketDetail; agent: Agent; locale: string }) {
  const executor = db();
  const cfg = await coreConfig();
  const dbZone = await detectDbTimezone(executor);
  const role = roleOn(ticket, agent);
  const isOpen = ticket.status_state === "open";
  const dept = await executor.selectFrom("department").select("manager_id").where("id", "=", ticket.dept_id).executeTakeFirst();
  const isManager = !!dept?.manager_id && dept.manager_id === agent.id;
  const mergeType = mergeTypeOf(ticket.flags);

  const can = {
    edit: role.perms.has(TicketPerm.EDIT),
    collaborators: !!ticket.thread_id && (role.perms.has(TicketPerm.REPLY) || role.perms.has(TicketPerm.EDIT)),
    merge: role.perms.has(TicketPerm.MERGE) && !ticket.ticket_pid,
    link: role.perms.has(TicketPerm.LINK) && mergeType === "visual",
    overdue: isOpen && isManager && !ticket.isoverdue,
    ban: agent.hasGlobalPerm(GlobalPerm.BANLIST),
    delete: role.perms.has(TicketPerm.DELETE),
    editEntries: false,
  };

  const [options, statuses, collaborators, related, entries, entryPerms, deleted, children, banned] = await Promise.all([
    can.edit ? openTicketOptions(executor, cfg, agent) : Promise.resolve(null),
    can.merge || can.link ? ticketStatusChoices(executor) : Promise.resolve([]),
    ticket.thread_id ? loadCollaborators(ticket.thread_id, executor) : Promise.resolve([]),
    relatedTickets(executor, ticket.ticket_id),
    ticket.thread_id ? loadThreadEntries(ticket.thread_id, executor) : Promise.resolve([]),
    entryEditContext({ tx: executor }, ticket.ticket_id, agent),
    executor.selectFrom("ticket_status").select("id").where("state", "=", "deleted").orderBy("sort").orderBy("id").executeTakeFirst(),
    executor.selectFrom("ticket").select("ticket_id").where("ticket_pid", "=", ticket.ticket_id).execute(),
    can.ban ? emailInBanList(executor, ticket.user_email ?? "") : Promise.resolve(false),
  ]);

  // Voci modificabili (non nascoste): TEA_EditThreadEntry / Edit and Resend
  const editable = entryPerms
    ? entries.filter((e) => !(e.flags & ThreadEntry.HIDDEN) && canEditEntry({ staff_id: e.staff_id, user_id: e.user_id, type: e.type }, agent, entryPerms))
    : [];
  can.editEntries = editable.length > 0;

  // Form del ticket con i valori attuali (ticket-edit.inc.php)
  const forms: TicketExtraData["edit"]["forms"] = [];
  const values: Record<string, string[]> = {};
  const fields: TicketExtraData["edit"]["fields"] = [];
  if (can.edit) {
    const formEntries = await executor
      .selectFrom("form_entry")
      .select(["id", "form_id"])
      .where("object_type", "=", FormType.TICKET)
      .where("object_id", "=", ticket.ticket_id)
      .orderBy("sort")
      .orderBy("id")
      .execute();
    for (const e of formEntries) {
      const def = await loadFormDef(executor, cfg, { id: e.form_id }, "staff");
      if (!def) continue;
      const view = formView(def, "staff");
      view.fields = view.fields.filter((f) => f.kind !== "thread" && f.kind !== "files" && f.kind !== "unsupported");
      forms.push(view);
      const answers = await executor.selectFrom("form_entry_values").select(["field_id", "value", "value_id"]).where("entry_id", "=", e.id).execute();
      for (const f of view.fields) {
        const a = answers.find((x) => x.field_id === f.id);
        if (!a || a.value === null) continue;
        let v: string[];
        if (f.kind === "priority" || f.kind === "department") v = a.value_id ? [String(a.value_id)] : [];
        else if (f.kind === "choices" || f.kind === "list") {
          try {
            const parsed = JSON.parse(a.value) as Record<string, string>;
            v = parsed && typeof parsed === "object" ? Object.keys(parsed) : [a.value];
          } catch {
            v = [a.value];
          }
        } else if (f.kind === "bool") v = a.value && a.value !== "0" ? ["1"] : [];
        else v = [a.value];
        values[f.key] = v;
      }
      for (const f of view.fields) {
        if (f.kind !== "info" && f.kind !== "break") fields.push({ key: String(f.id), label: f.label, kind: "form", fieldId: f.id });
      }
    }
    fields.push(
      { key: "topic", label: "topic", kind: "topic" },
      { key: "sla", label: "sla", kind: "sla" },
      { key: "duedate", label: "duedate", kind: "duedate" },
      { key: "source", label: "source", kind: "source" },
    );
  }

  const topics = options?.topics ?? [];
  if (options && ticket.topic_id && !topics.some((t) => t.id === ticket.topic_id)) topics.push({ id: ticket.topic_id, name: ticket.topic_name ?? `#${ticket.topic_id}` });
  // merge-tickets.tmpl.php: preselezionato lo stato chiuso non disattivabile (TicketStatus::INTERNAL)
  const internalClosed = await executor
    .selectFrom("ticket_status")
    .select("id")
    .where("state", "=", "closed")
    .where(sql<boolean>`(mode & ${sql.lit(TicketStatus.INTERNAL)}) != 0`)
    .orderBy("sort")
    .execute();
  const duedateRow = await executor.selectFrom("ticket").select("duedate").where("ticket_id", "=", ticket.ticket_id).executeTakeFirst();

  const data: TicketExtraData = {
    ticketId: ticket.ticket_id,
    number: ticket.number,
    can,
    edit: {
      userId: ticket.user_id,
      userName: ticket.user_name,
      userEmail: ticket.user_email,
      source: ticket.source,
      topicId: ticket.topic_id,
      slaId: ticket.sla_id,
      duedate: dbDateToInput(duedateRow?.duedate ?? null, dbZone),
      isClosed: ticket.status_state === "closed",
      topics,
      slas: options?.slas ?? [],
      sources: [...TICKET_SOURCE_KEYS],
      forms,
      values,
      fields,
    },
    collaborators: collaborators.map((c) => ({ id: c.id, userId: c.user_id, name: c.name, email: c.email ?? "", active: c.active })),
    related: { mergeType: related?.mergeType ?? "visual", tickets: related?.tickets ?? [] },
    closedStatuses: statuses.filter((s) => s.state === "closed").map((s) => ({ id: s.id, name: s.name })),
    defaultChildStatusId: internalClosed[internalClosed.length - 1]?.id ?? 0,
    parentStatuses: statuses.map((s) => ({ id: s.id, name: s.name })),
    isOverdue: !!ticket.isoverdue,
    ownerEmail: ticket.user_email ?? "",
    banned,
    deletedStatusId: deleted?.id ?? null,
    hasChildren: !!(ticket.flags & Ticket.PARENT) && children.length > 0,
    entries: editable.map((e) => ({ id: e.id, type: e.type, poster: e.poster, created: e.created, title: e.title ?? "", body: e.body })),
  };
  if (!can.delete || !data.deletedStatusId) data.can.delete = false;

  if (!Object.values(data.can).some(Boolean)) return null;
  return <TicketExtraMenu data={data} />;
}
