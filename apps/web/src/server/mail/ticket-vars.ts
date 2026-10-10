import "server-only";

import { sql } from "kysely";

import type { ConfigNamespace } from "../config/config";
import { table, type DbOrTx } from "../db";
import { PersonsName } from "../format/persons-name";
import { installConfig } from "../env";
import { ticketAuthToken } from "./message-id";
import { VarBag, type TemplateVariable, type VariableReplacer } from "./variables";
import { FormattedDate } from "./formatted-date";
import { formAnswerMap, loadStaffInfo, staffVar, deptVar, topicVar } from "./org-vars";

/** Ticket, proprietario e collaboratori nei template (Ticket::replaceVars, TicketOwner, Collaborator). */

interface TicketInfo {
  ticket_id: number;
  number: string;
  user_id: number;
  dept_id: number;
  topic_id: number;
  staff_id: number;
  team_id: number;
  status_id: number;
  source: string;
  created: string;
  closed: string | null;
  lastupdate: string | null;
  duedate: string | null;
  est_duedate: string | null;
}

async function loadTicketInfo(executor: DbOrTx, ticketId: number): Promise<TicketInfo | null> {
  const t = await executor
    .selectFrom("ticket")
    .select(["ticket_id", "number", "user_id", "dept_id", "topic_id", "staff_id", "team_id", "status_id", "source", "created", "closed", "lastupdate", "duedate", "est_duedate"])
    .where("ticket_id", "=", ticketId)
    .executeTakeFirst();
  return (t as TicketInfo | undefined) ?? null;
}

interface OwnerInfo {
  id: number;
  name: string;
  email: string;
  org_name: string | null;
}

export async function loadUserContact(executor: DbOrTx, userId: number): Promise<OwnerInfo | null> {
  const u = await executor
    .selectFrom("user as u")
    .leftJoin("user_email as e", "e.id", "u.default_email_id")
    .leftJoin("organization as o", "o.id", "u.org_id")
    .select(["u.id", "u.name", "e.address as email", "o.name as org_name"])
    .where("u.id", "=", userId)
    .executeTakeFirst();
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email ?? "", org_name: u.org_name ?? null };
}

/** User::getName: nome, o la parte locale dell'email se il nome è vuoto. */
export function userPersonsName(u: OwnerInfo, cfg: ConfigNamespace): PersonsName {
  const raw = u.name || u.email.split("@")[0];
  return new PersonsName(raw, cfg.str("client_name_format"));
}

/** TicketUser::getTicketLink */
export function ticketLink(cfg: ConfigNamespace, t: TicketInfo, contact: { isOwner: boolean; id: number }, withToken: boolean): string {
  const base = cfg.str("helpdesk_url").replace(/\/+$/, "");
  if (withToken && cfg.bool("allow_auth_tokens")) {
    const token = ticketAuthToken({
      isOwner: contact.isOwner,
      contactId: contact.id,
      ticketId: t.ticket_id,
      createDate: t.created,
      secretSalt: installConfig().secretSalt,
    });
    return `${base}/view.php?auth=${encodeURIComponent(token).replace(/%20/g, "+")}`;
  }
  return `${base}/view.php?id=${t.ticket_id}`;
}

/** TicketOwner / Collaborator come destinatario dei template. */
export function contactVar(
  u: OwnerInfo,
  cfg: ConfigNamespace,
  t: TicketInfo | null,
  opts: { isOwner: boolean; contactId: number; numCollaborators: number; answers?: Map<string, string> },
): TemplateVariable {
  const name = userPersonsName(u, cfg);
  return new VarBag(
    {
      name,
      email: u.email,
      id: u.id,
      organization: u.org_name ?? "",
      ticket_link: () => (t ? ticketLink(cfg, t, { isOwner: opts.isOwner, id: opts.contactId }, opts.numCollaborators === 0) : ""),
      ...Object.fromEntries(opts.answers ?? []),
    },
    () => name.toString(),
  );
}

interface TicketVarDeps {
  info: TicketInfo;
  cfg: ConfigNamespace;
  dbZone: string;
  owner: TemplateVariable | null;
  ownerEmail: string;
  ownerPhone: string;
  answers: Map<string, string>;
  dept: TemplateVariable | null;
  topic: TemplateVariable | null;
  staff: TemplateVariable | null;
  team: TemplateVariable | null;
  status: TemplateVariable | null;
  priority: TemplateVariable | null;
  assigned: string;
  sourceLabel: string;
}

function ticketVar(d: TicketVarDeps): TemplateVariable {
  const base = d.cfg.str("helpdesk_url").replace(/\/+$/, "");
  const date = (v: string | null | undefined) => (v ? new FormattedDate(v, d.cfg, d.dbZone) : "");
  const fixed: Record<string, unknown> = {
    id: d.info.ticket_id,
    number: d.info.number,
    phone: d.ownerPhone,
    phone_number: d.ownerPhone,
    client_link: `${base}/view.php?t=${d.info.number}`,
    staff_link: `${base}/scp/tickets.php?id=${d.info.ticket_id}`,
    create_date: date(d.info.created),
    due_date: date(d.info.duedate ?? d.info.est_duedate),
    close_date: date(d.info.closed),
    last_update: date(d.info.lastupdate),
    user: d.owner ?? "",
    name: d.owner ? (d.owner.getVar("name", undefined as unknown as VariableReplacer) as PersonsName) : "",
    email: d.ownerEmail,
    dept: d.dept ?? "",
    topic: d.topic ?? "",
    staff: d.staff ?? "",
    team: d.team ?? "",
    status: d.status ?? "",
    priority: d.priority ?? "",
    assigned: d.assigned,
    source: d.sourceLabel,
    subject: d.answers.get("subject") ?? "",
  };
  return {
    getVar(tag: string) {
      // getVar del PHP: casi speciali, poi risposte del form del ticket, poi getter
      if (["phone", "phone_number", "client_link", "staff_link", "create_date", "due_date", "close_date", "last_update", "user"].includes(tag)) return fixed[tag];
      if (d.answers.has(tag) && tag !== "priority") return d.answers.get(tag);
      return fixed[tag];
    },
    asVar() {
      return d.info.number;
    },
  };
}

const SOURCES: Record<string, string> = { Web: "Web", Email: "Email", Phone: "Phone", API: "API", Other: "Other" };

/** Costruisce tutti gli oggetti di un ticket per i template (Ticket::replaceVars). */
export async function buildTicketVars(executor: DbOrTx, ticketId: number, cfg: ConfigNamespace, dbZone: string) {
  const info = await loadTicketInfo(executor, ticketId);
  if (!info) return null;
  const [owner, answers, dept, topic, staff, collabs, statusRow, ownerAnswers, teamRow] = await Promise.all([
    loadUserContact(executor, info.user_id),
    formAnswerMap(executor, "T", ticketId),
    deptVar(executor, info.dept_id, cfg),
    topicVar(executor, info.topic_id),
    loadStaffInfo(executor, info.staff_id),
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${table("thread_collaborator")} C JOIN ${table("thread")} T ON (T.id = C.thread_id)
      WHERE T.object_type = 'T' AND T.object_id = ${ticketId}`.execute(executor),
    executor.selectFrom("ticket_status").select(["id", "name", "state"]).where("id", "=", info.status_id).executeTakeFirst(),
    formAnswerMap(executor, "U", info.user_id),
    info.team_id ? executor.selectFrom("team").select(["team_id", "name"]).where("team_id", "=", info.team_id).executeTakeFirst() : Promise.resolve(undefined),
  ]);
  const prio = await executor
    .selectFrom("ticket__cdata as c")
    .innerJoin("ticket_priority as p", (j) => j.on(sql<boolean>`p.priority_id = c.priority`))
    .select(["p.priority_id", "p.priority", "p.priority_desc", "p.priority_color", "p.priority_urgency"])
    .where("c.ticket_id", "=", ticketId)
    .executeTakeFirst()
    .catch(() => undefined);
  const numCollaborators = Number(collabs.rows[0]?.n ?? 0);
  const ownerVar = owner ? contactVar(owner, cfg, info, { isOwner: true, contactId: owner.id, numCollaborators, answers: ownerAnswers }) : null;
  const staffV = staff ? staffVar(staff, cfg) : null;
  const assigned = [staffV ? staffV.asVar(undefined as unknown as VariableReplacer) : "", teamRow?.name ?? ""].filter(Boolean).join("/");
  const ticket = ticketVar({
    info,
    cfg,
    dbZone,
    owner: ownerVar,
    ownerEmail: owner?.email ?? "",
    ownerPhone: ownerAnswers.get("phone") ?? "",
    answers,
    dept,
    topic,
    staff: staffV,
    team: teamRow ? new VarBag({ name: teamRow.name, id: teamRow.team_id }, teamRow.name) : null,
    status: statusRow ? new VarBag({ name: statusRow.name, state: statusRow.state, id: statusRow.id }, statusRow.name) : null,
    priority: prio ? new VarBag({ desc: prio.priority_desc, priority: prio.priority, color: prio.priority_color, id: prio.priority_id }, prio.priority_desc) : null,
    assigned,
    sourceLabel: SOURCES[info.source] ?? info.source,
  });
  return { info, ticket, owner, ownerVar, numCollaborators, dept, staff: staffV };
}
