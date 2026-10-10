import "server-only";

import { sql } from "kysely";

import { CustomQueue, Topic } from "@/lib/osticket/flags";

import { NOW, type DbOrTx } from "../../db";
import { intval, isNumeric, isset, phpLooseEquals, truthy, type PhpVars } from "../../php/values";
import { hasHash } from "./common";
import type { ConfigWriter } from "./config-write";
import { isset1, needRecipients, v } from "./settings-util";
import { validate, type Errors, type FieldRule } from "./validator";

/**
 * Impostazioni di ticket e task: OsticketConfig::updateTicketsSettings (con autorisposte e avvisi,
 * updateAutoresponderSettings / updateAlertsSettings) e updateTasksSettings.
 */

/** OsticketConfig::updateTicketsSettings */
export async function updateTicketsSettings(executor: DbOrTx, cfg: ConfigWriter, vars: PhpVars, errors: Errors): Promise<boolean> {
  const f: Record<string, FieldRule> = {
    default_sla_id: { type: "int", required: true, error: "required" },
    default_ticket_status_id: { type: "int", required: true, error: "required" },
    default_priority_id: { type: "int", required: true, error: "required" },
    max_open_tickets: { type: "int", required: true, error: "invalid" },
  };
  // enable_captcha richiede GD/PNG: disponibili nell'installazione PHP di riferimento

  if (truthy(vars.default_help_topic)) {
    const t = await executor.selectFrom("help_topic").select("flags").where("topic_id", "=", intval(vars.default_help_topic)).executeTakeFirst();
    if (t && !((t.flags ?? 0) & Topic.ACTIVE)) errors.default_help_topic = "inactive";
  }
  if (!hasHash(vars.ticket_number_format)) errors.ticket_number_format = "hash";
  if (!isset(vars, "default_ticket_queue")) errors.default_ticket_queue = "required";
  else if (!(isNumeric(vars.default_ticket_queue) && (await executor.selectFrom("queue").select("id").where("id", "=", intval(vars.default_ticket_queue)).executeTakeFirst())))
    errors.default_ticket_queue = "required";

  // NB: autorisposte e avvisi si salvano subito, anche se poi la validazione dei campi fallisce
  await updateAutoresponderSettings(executor, cfg, vars, errors);
  await updateAlertsSettings(executor, cfg, vars, errors);

  if (!validate(f, vars, errors) || Object.keys(errors).length) return false;

  // Ordinamento delle code (qsort[queue_id] = sort) tra le code con FLAG_QUEUE
  const qsort = vars.qsort;
  if (qsort && typeof qsort === "object" && !Array.isArray(qsort)) {
    for (const [qid, sort] of Object.entries(qsort)) {
      const q = await executor.selectFrom("queue").select(["id", "sort"]).where("id", "=", intval(qid)).where(sql<boolean>`(flags & ${sql.lit(CustomQueue.QUEUE)}) != 0`).executeTakeFirst();
      if (!q) continue;
      if (phpLooseEquals(q.sort, sort as never)) continue;
      await executor.updateTable("queue").set({ sort: intval(sort), updated: NOW }).where("id", "=", q.id).execute();
    }
  }

  return cfg.updateAll(executor, {
    ticket_number_format: truthy(vars.ticket_number_format) ? v(vars.ticket_number_format) : "######",
    ticket_sequence_id: truthy(vars.ticket_sequence_id) ? v(vars.ticket_sequence_id) : 0,
    queue_bucket_counts: isset1(vars, "queue_bucket_counts"),
    default_priority_id: v(vars.default_priority_id),
    default_help_topic: v(vars.default_help_topic),
    default_ticket_status_id: v(vars.default_ticket_status_id),
    default_sla_id: v(vars.default_sla_id),
    max_open_tickets: v(vars.max_open_tickets),
    enable_captcha: isset1(vars, "enable_captcha"),
    auto_claim_tickets: isset1(vars, "auto_claim_tickets"),
    auto_refer_closed: isset1(vars, "auto_refer_closed"),
    collaborator_ticket_visibility: isset1(vars, "collaborator_ticket_visibility"),
    require_topic_to_close: isset1(vars, "require_topic_to_close"),
    show_related_tickets: isset1(vars, "show_related_tickets"),
    allow_client_updates: isset1(vars, "allow_client_updates"),
    ticket_lock: v(vars.ticket_lock),
    default_ticket_queue: v(vars.default_ticket_queue),
    allow_external_images: isset1(vars, "allow_external_images"),
  });
}

/** OsticketConfig::updateTasksSettings */
export async function updateTasksSettings(executor: DbOrTx, cfg: ConfigWriter, vars: PhpVars, errors: Errors): Promise<boolean> {
  const f: Record<string, FieldRule> = {
    default_task_priority_id: { type: "int", required: true, error: "required" },
  };
  if (!hasHash(vars.task_number_format)) errors.task_number_format = "hash";
  validate(f, vars, errors);
  needRecipients(vars, errors, "task_alert_active", ["task_alert_admin", "task_alert_dept_manager", "task_alert_dept_members", "task_alert_acct_manager"]);
  needRecipients(vars, errors, "task_activity_alert_active", ["task_activity_alert_laststaff", "task_activity_alert_assigned", "task_activity_alert_dept_manager"]);
  needRecipients(vars, errors, "task_transfer_alert_active", ["task_transfer_alert_assigned", "task_transfer_alert_dept_manager", "task_transfer_alert_dept_members"]);
  needRecipients(vars, errors, "task_overdue_alert_active", ["task_overdue_alert_assigned", "task_overdue_alert_dept_manager", "task_overdue_alert_dept_members"]);
  needRecipients(vars, errors, "task_assignment_alert_active", ["task_assignment_alert_staff", "task_assignment_alert_team_lead", "task_assignment_alert_team_members"]);
  if (Object.keys(errors).length) return false;
  return cfg.updateAll(executor, {
    task_number_format: truthy(vars.task_number_format) ? v(vars.task_number_format) : "######",
    task_sequence_id: truthy(vars.task_sequence_id) ? v(vars.task_sequence_id) : 0,
    default_task_priority_id: v(vars.default_task_priority_id),
    default_task_sla_id: v(vars.default_task_sla_id),
    task_alert_active: v(vars.task_alert_active),
    task_alert_admin: isset1(vars, "task_alert_admin"),
    task_alert_dept_manager: isset1(vars, "task_alert_dept_manager"),
    task_alert_dept_members: isset1(vars, "task_alert_dept_members"),
    task_activity_alert_active: v(vars.task_activity_alert_active),
    task_activity_alert_laststaff: isset1(vars, "task_activity_alert_laststaff"),
    task_activity_alert_assigned: isset1(vars, "task_activity_alert_assigned"),
    task_activity_alert_dept_manager: isset1(vars, "task_activity_alert_dept_manager"),
    task_assignment_alert_active: v(vars.task_assignment_alert_active),
    task_assignment_alert_staff: isset1(vars, "task_assignment_alert_staff"),
    task_assignment_alert_team_lead: isset1(vars, "task_assignment_alert_team_lead"),
    task_assignment_alert_team_members: isset1(vars, "task_assignment_alert_team_members"),
    task_transfer_alert_active: v(vars.task_transfer_alert_active),
    task_transfer_alert_assigned: isset1(vars, "task_transfer_alert_assigned"),
    task_transfer_alert_dept_manager: isset1(vars, "task_transfer_alert_dept_manager"),
    task_transfer_alert_dept_members: isset1(vars, "task_transfer_alert_dept_members"),
    task_overdue_alert_active: v(vars.task_overdue_alert_active),
    task_overdue_alert_assigned: isset1(vars, "task_overdue_alert_assigned"),
    task_overdue_alert_dept_manager: isset1(vars, "task_overdue_alert_dept_manager"),
    task_overdue_alert_dept_members: isset1(vars, "task_overdue_alert_dept_members"),
  });
}

async function updateAutoresponderSettings(executor: DbOrTx, cfg: ConfigWriter, vars: PhpVars, errors: Errors): Promise<boolean> {
  if (Object.keys(errors).length) return false;
  return cfg.updateAll(executor, {
    ticket_autoresponder: isset1(vars, "ticket_autoresponder"),
    message_autoresponder: isset1(vars, "message_autoresponder"),
    message_autoresponder_collabs: isset1(vars, "message_autoresponder_collabs"),
    ticket_notice_active: isset1(vars, "ticket_notice_active"),
    overlimit_notice_active: isset1(vars, "overlimit_notice_active"),
  });
}

async function updateAlertsSettings(executor: DbOrTx, cfg: ConfigWriter, vars: PhpVars, errors: Errors): Promise<boolean> {
  needRecipients(vars, errors, "ticket_alert_active", ["ticket_alert_admin", "ticket_alert_dept_manager", "ticket_alert_dept_members", "ticket_alert_acct_manager"]);
  needRecipients(vars, errors, "message_alert_active", ["message_alert_laststaff", "message_alert_assigned", "message_alert_dept_manager", "message_alert_acct_manager"]);
  needRecipients(vars, errors, "note_alert_active", ["note_alert_laststaff", "note_alert_assigned", "note_alert_dept_manager"]);
  needRecipients(vars, errors, "transfer_alert_active", ["transfer_alert_assigned", "transfer_alert_dept_manager", "transfer_alert_dept_members"]);
  needRecipients(vars, errors, "overdue_alert_active", ["overdue_alert_assigned", "overdue_alert_dept_manager", "overdue_alert_dept_members"]);
  needRecipients(vars, errors, "assigned_alert_active", ["assigned_alert_staff", "assigned_alert_team_lead", "assigned_alert_team_members"]);
  if (Object.keys(errors).length) return false;
  return cfg.updateAll(executor, {
    ticket_alert_active: v(vars.ticket_alert_active),
    ticket_alert_admin: isset1(vars, "ticket_alert_admin"),
    ticket_alert_dept_manager: isset1(vars, "ticket_alert_dept_manager"),
    ticket_alert_dept_members: isset1(vars, "ticket_alert_dept_members"),
    ticket_alert_acct_manager: isset1(vars, "ticket_alert_acct_manager"),
    message_alert_active: v(vars.message_alert_active),
    message_alert_laststaff: isset1(vars, "message_alert_laststaff"),
    message_alert_assigned: isset1(vars, "message_alert_assigned"),
    message_alert_dept_manager: isset1(vars, "message_alert_dept_manager"),
    message_alert_acct_manager: isset1(vars, "message_alert_acct_manager"),
    note_alert_active: v(vars.note_alert_active),
    note_alert_laststaff: isset1(vars, "note_alert_laststaff"),
    note_alert_assigned: isset1(vars, "note_alert_assigned"),
    note_alert_dept_manager: isset1(vars, "note_alert_dept_manager"),
    assigned_alert_active: v(vars.assigned_alert_active),
    assigned_alert_staff: isset1(vars, "assigned_alert_staff"),
    assigned_alert_team_lead: isset1(vars, "assigned_alert_team_lead"),
    assigned_alert_team_members: isset1(vars, "assigned_alert_team_members"),
    transfer_alert_active: v(vars.transfer_alert_active),
    transfer_alert_assigned: isset1(vars, "transfer_alert_assigned"),
    transfer_alert_dept_manager: isset1(vars, "transfer_alert_dept_manager"),
    transfer_alert_dept_members: isset1(vars, "transfer_alert_dept_members"),
    overdue_alert_active: v(vars.overdue_alert_active),
    overdue_alert_assigned: isset1(vars, "overdue_alert_assigned"),
    overdue_alert_dept_manager: isset1(vars, "overdue_alert_dept_manager"),
    overdue_alert_dept_members: isset1(vars, "overdue_alert_dept_members"),
    send_sys_errors: isset1(vars, "send_sys_errors"),
    send_sql_errors: isset1(vars, "send_sql_errors"),
    send_login_errors: isset1(vars, "send_login_errors"),
  });
}
