import "server-only";

import type { ConfigNamespace } from "../config/config";
import type { DbOrTx } from "../db";

/**
 * Template email (EmailTemplateGroup::getMsgTemplate, include/class.template.php): gruppo del reparto
 * (department.tpl_id) o predefinito (core.default_template_id), poi riga di email_template per code_name.
 */
export type TemplateCode =
  | "ticket.autoresp" | "ticket.autoreply" | "message.autoresp" | "ticket.notice" | "ticket.overlimit" | "ticket.reply"
  | "ticket.activity.notice" | "ticket.alert" | "message.alert" | "note.alert" | "assigned.alert" | "transfer.alert"
  | "ticket.overdue" | "task.alert" | "task.activity.notice" | "task.activity.alert" | "task.assignment.alert"
  | "task.transfer.alert" | "task.overdue.alert";

export async function templateGroupFor(executor: DbOrTx, deptId: number, cfg: ConfigNamespace): Promise<number> {
  if (deptId) {
    const d = await executor.selectFrom("department").select("tpl_id").where("id", "=", deptId).executeTakeFirst();
    if (d?.tpl_id) {
      const g = await executor.selectFrom("email_template_group").select("tpl_id").where("tpl_id", "=", d.tpl_id).executeTakeFirst();
      if (g) return g.tpl_id;
    }
  }
  return cfg.int("default_template_id");
}

export async function loadMsgTemplate(executor: DbOrTx, groupId: number, code: TemplateCode): Promise<{ subj: string; body: string } | null> {
  const t = await executor
    .selectFrom("email_template")
    .select(["subject", "body"])
    .where("tpl_id", "=", groupId)
    .where("code_name", "=", code)
    .executeTakeFirst();
  return t ? { subj: t.subject, body: t.body } : null;
}
