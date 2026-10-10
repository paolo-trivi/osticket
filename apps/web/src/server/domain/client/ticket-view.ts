import "server-only";

import { sql } from "kysely";

import { DynamicFormField } from "@/lib/osticket/flags";
import { AttachmentType, FormType, ObjectType, ThreadEntryType } from "@/lib/osticket/object-types";

import type { ConfigNamespace } from "../../config/config";
import { db, table, type DbOrTx } from "../../db";
import { cleanFromDb, fieldToString, hasData, isEditableTo, isPresentationOnly, isStorable } from "../forms/fields";
import { loadFormDef } from "../forms/load";
import { findTicketThreadId } from "../thread/ids";
import { TicketRecord } from "../ticket/record";
import { ticketIsReopenable, loadStatus } from "../ticket/status";
import { loadThreadEntries, loadThreadEvents, type ThreadEntryView, type ThreadEventView } from "../ticket/ticket";
import { mergeTypeOf } from "../ticket/merge-flags";
import type { ClientIdentity } from "./identity";
import { clientCanAccess } from "./tickets";

/** Vista del ticket per il cliente (view.inc.php: thread senza note interne, campi visibili ai clienti) e allegati. */

interface ClientAnswer {
  formTitle: string;
  label: string;
  value: string;
}

interface ClientTicketView {
  id: number;
  number: string;
  subject: string;
  statusName: string;
  state: string;
  dept: string;
  created: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  isOwner: boolean;
  /** risposta consentita: aperto, oppure chiuso e riapribile; non per i figli di un merge */
  canReply: boolean;
  reopenOnReply: boolean;
  closedNotReopenable: boolean;
  /** figlio di un merge (risposte al padre) */
  parentId: number | null;
  canEdit: boolean;
  answers: ClientAnswer[];
  entries: ThreadEntryView[];
  events: ThreadEventView[];
  threadId: number;
}

/** Eventi mostrati ai clienti (include/client/templates/thread-entries.tmpl.php) */
const CLIENT_EVENTS = new Set(["created", "closed", "reopened", "edited", "collab", "merged"]);

/**
 * Vista del ticket per il cliente (view.inc.php): reparto pubblico o predefinito, campi visibili ai
 * clienti (esclusi oggetto, priorità e campi esterni), thread M/R (più le voci del cliente), eventi.
 */
export async function loadClientTicketView(cfg: ConfigNamespace, client: ClientIdentity, ticketId: number, executor: DbOrTx = db()): Promise<ClientTicketView | null> {
  if (!(await clientCanAccess(client, ticketId, executor))) return null;
  const t = await executor
    .selectFrom("ticket as t")
    .innerJoin("ticket_status as s", "s.id", "t.status_id")
    .leftJoin("department as d", "d.id", "t.dept_id")
    .leftJoin("ticket__cdata as cd", "cd.ticket_id", "t.ticket_id")
    .innerJoin("user as u", "u.id", "t.user_id")
    .leftJoin("user_email as ue", "ue.id", "u.default_email_id")
    .select(["t.ticket_id", "t.number", "t.created", "t.flags", "t.ticket_pid", "t.user_id", "s.name as sname", "s.state", "d.name as dname", "d.ispublic", "cd.subject", "u.name as uname", "ue.address"])
    .where("t.ticket_id", "=", ticketId)
    .executeTakeFirst();
  if (!t) return null;
  let dept = t.ispublic ? (t.dname ?? "") : "";
  if (!t.ispublic) {
    const d = await executor.selectFrom("department").select("name").where("id", "=", cfg.int("default_dept_id")).executeTakeFirst();
    dept = d?.name ?? "";
  }
  const threadId = (await findTicketThreadId(executor, ticketId)) ?? 0;
  const rec = await TicketRecord.load(executor, ticketId);
  const status = await loadStatus(executor, rec!.get("status_id"));
  const closed = status?.state === "closed";
  const reopenable = closed && status ? await ticketIsReopenable(executor, rec!.row, status) : false;
  const isChild = !!t.ticket_pid && mergeTypeOf(t.flags) !== "visual";

  // Campi visibili ai clienti con un valore (DynamicFormEntry::forTicket)
  const entries = await executor.selectFrom("form_entry").select(["id", "form_id"]).where("object_type", "=", FormType.TICKET).where("object_id", "=", ticketId).orderBy("sort").orderBy("id").execute();
  const answers: ClientAnswer[] = [];
  let canEdit = false;
  let phone = "";
  for (const e of entries) {
    const def = await loadFormDef(executor, cfg, { id: e.form_id }, "client");
    if (!def) continue;
    const vals = await executor.selectFrom("form_entry_values").select(["field_id", "value", "value_id"]).where("entry_id", "=", e.id).execute();
    for (const f of def.fields) {
      if (isEditableTo(f, "client") && isStorable(f) && hasData(f) && !isPresentationOnly(f)) canEdit = true;
      const v = vals.find((x) => x.field_id === f.id);
      if (!v || !isStorable(f) || ["subject", "priority"].includes(f.name) || !(f.flags & DynamicFormField.CLIENT_VIEW)) continue;
      const text = fieldToString(f, cleanFromDb(f, v.value, v.value_id));
      if (text) answers.push({ formTitle: def.title, label: f.label, value: text });
    }
  }
  const phoneRow = await sql<{ value: string | null }>`SELECT V.value FROM ${table("form_entry")} FE JOIN ${table("form_entry_values")} V ON (V.entry_id = FE.id)
    JOIN ${table("form_field")} FF ON (FF.id = V.field_id) WHERE FE.object_type = 'U' AND FE.object_id = ${t.user_id} AND FF.name = 'phone' LIMIT 1`.execute(executor);
  phone = phoneRow.rows[0]?.value ?? "";

  const all = threadId ? await loadThreadEntries(threadId, executor) : [];
  const visible = all.filter((e) => e.type === ThreadEntryType.MESSAGE || e.type === ThreadEntryType.RESPONSE || (e.user_id && e.user_id === client.id));
  const events = threadId ? (await loadThreadEvents(threadId, executor)).filter((e) => CLIENT_EVENTS.has(e.name)) : [];
  return {
    id: t.ticket_id,
    number: t.number ?? "",
    subject: t.subject ?? "",
    statusName: t.sname,
    state: t.state ?? "",
    dept,
    created: t.created,
    ownerName: t.uname,
    ownerEmail: t.address ?? "",
    ownerPhone: phone,
    isOwner: t.user_id === client.id,
    canReply: (!closed || reopenable) && !isChild,
    reopenOnReply: closed && reopenable,
    closedNotReopenable: closed && !reopenable,
    parentId: isChild ? t.ticket_pid : null,
    canEdit: canEdit && t.user_id === client.id,
    answers,
    entries: visible,
    events,
    threadId,
  };
}

/** Allegato scaricabile dal cliente: voce del thread visibile (M/R o propria) di un ticket accessibile */
export async function clientAttachment(client: ClientIdentity, key: string, executor: DbOrTx = db()) {
  const ref = await executor
    .selectFrom("file as f")
    .innerJoin("attachment as a", "a.file_id", "f.id")
    .innerJoin("thread_entry as e", (j) => j.onRef("e.id", "=", "a.object_id").on("a.type", "=", AttachmentType.THREAD_ENTRY))
    .innerJoin("thread as th", "th.id", "e.thread_id")
    .select(["f.id as file_id", "a.name", "th.object_id", "th.object_type", "e.type", "e.user_id"])
    .where("f.key", "=", key)
    .execute();
  for (const r of ref) {
    if (r.object_type !== ObjectType.TICKET) continue;
    if (!(r.type === ThreadEntryType.MESSAGE || r.type === ThreadEntryType.RESPONSE || r.user_id === client.id)) continue;
    if (await clientCanAccess(client, r.object_id, executor)) return { fileId: r.file_id, name: r.name };
  }
  return null;
}
