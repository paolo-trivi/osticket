import "server-only";

import { getTranslations } from "next-intl/server";

import type { FormSection } from "@/lib/admin/form-schema";
import { Dept, StaffDeptAccess } from "@/lib/osticket/flags";
import { db } from "@/server/db";
import { deptOptions, emailOptions, roleOptions, scheduleOptions, slaOptions, staffOptions, templateOptions } from "@/server/domain/admin/lookups";

/** Sezioni del form reparto (include/staff/department.inc.php) con i valori correnti. */
export async function deptSections(deptId: number | null): Promise<FormSection[] | null> {
  const t = await getTranslations("admDepts");
  const u = await getTranslations("admUi");
  const executor = db();
  const dept = deptId ? await executor.selectFrom("department").selectAll().where("id", "=", deptId).executeTakeFirst() : null;
  if (deptId && !dept) return null;
  const flags = dept?.flags ?? Dept.ACTIVE;
  const status = flags & Dept.ACTIVE ? "active" : flags & Dept.ARCHIVED ? "archived" : "disabled";
  const assignment = flags & Dept.ASSIGN_MEMBERS_ONLY ? "members" : flags & Dept.ASSIGN_PRIMARY_ONLY ? "primary" : "all";
  const [depts, slas, schedules, staff, emails, templates, roles] = await Promise.all([
    deptOptions(executor),
    slaOptions(executor),
    scheduleOptions(executor, "bizhrs"),
    staffOptions(executor),
    emailOptions(executor),
    templateOptions(executor),
    roleOptions(executor),
  ]);
  const primary = deptId ? await executor.selectFrom("staff").select(["staff_id", "role_id"]).where("dept_id", "=", deptId).execute() : [];
  const extended = deptId ? await executor.selectFrom("staff_dept_access").select(["staff_id", "role_id", "flags"]).where("dept_id", "=", deptId).execute() : [];
  const none = (label: string) => [{ value: "0", label }];
  return [
    {
      title: t("sections.settings"),
      fields: [
        { kind: "hidden", name: "do", value: deptId ? "update" : "create" },
        { kind: "hidden", name: "id", value: deptId ? String(deptId) : "" },
        { kind: "text", name: "name", label: t("name"), value: dept?.name ?? "", required: true },
        {
          kind: "select",
          name: "pid",
          label: t("parent"),
          value: dept?.pid ? String(dept.pid) : "",
          options: [{ value: "", label: t("topLevel") }, ...depts.filter((d) => d.value !== String(deptId) && d.ispublic)],
        },
        {
          kind: "select",
          name: "status",
          label: t("status"),
          value: status,
          options: ["active", "disabled", "archived"].map((s) => ({ value: s, label: u(`status.${s}`) })),
        },
        {
          kind: "radio",
          name: "ispublic",
          label: t("type"),
          value: dept ? String(dept.ispublic) : "1",
          options: [
            { value: "1", label: t("public") },
            { value: "0", label: t("private") },
          ],
        },
        { kind: "select", name: "sla_id", label: t("sla"), value: String(dept?.sla_id ?? 0), options: [...none(t("systemDefault")), ...slas] },
        { kind: "select", name: "schedule_id", label: t("schedule"), value: String(dept?.schedule_id ?? 0), options: [...none(t("systemDefault")), ...schedules] },
        { kind: "select", name: "manager_id", label: t("manager"), value: String(dept?.manager_id ?? 0), options: [...none(t("noManager")), ...staff] },
        {
          kind: "select",
          name: "assignment_flag",
          label: t("assignment"),
          value: assignment,
          options: ["all", "members", "primary"].map((v) => ({ value: v, label: t(`assign.${v}`) })),
        },
        { kind: "checkbox", name: "disable_auto_claim", label: t("disableAutoClaim"), checked: !!(flags & Dept.DISABLE_AUTO_CLAIM) },
        { kind: "checkbox", name: "disable_reopen_auto_assign", label: t("disableReopenAutoAssign"), checked: !!(flags & Dept.DISABLE_REOPEN_AUTO_ASSIGN) },
      ],
    },
    {
      title: t("sections.email"),
      fields: [
        { kind: "select", name: "email_id", label: t("outgoingEmail"), value: String(dept?.email_id ?? 0), options: [...none(t("systemDefault")), ...emails] },
        { kind: "select", name: "tpl_id", label: t("template"), value: String(dept?.tpl_id ?? 0), options: [...none(t("systemDefault")), ...templates] },
        { kind: "select", name: "autoresp_email_id", label: t("autorespEmail"), value: String(dept?.autoresp_email_id ?? 0), options: [...none(t("deptEmail")), ...emails] },
        { kind: "checkbox", name: "ticket_auto_response", value: "0", label: t("disableNewTicketAutoresp"), checked: dept ? !dept.ticket_auto_response : false },
        { kind: "checkbox", name: "message_auto_response", value: "0", label: t("disableNewMessageAutoresp"), checked: dept ? !dept.message_auto_response : false },
        {
          kind: "select",
          name: "group_membership",
          label: t("recipients"),
          value: String(dept?.group_membership ?? 1),
          options: [
            { value: "2", label: t("alerts.disabled") },
            { value: "3", label: t("alerts.admin") },
            { value: "0", label: t("alerts.dept") },
            { value: "1", label: t("alerts.extended") },
          ],
        },
        { kind: "textarea", name: "signature", label: t("signature"), value: dept?.signature ?? "", rows: 4, wide: true },
      ],
    },
    {
      title: t("sections.access"),
      desc: t("accessDesc"),
      fields: [
        {
          kind: "access",
          name: "members",
          label: t("members"),
          ids: "members",
          role: "member_role",
          alerts: "member_alerts",
          choices: staff,
          roles,
          wide: true,
          selected: [
            ...primary.map((p) => ({ id: String(p.staff_id), role: String(p.role_id), alerts: true })),
            ...extended.map((e) => ({ id: String(e.staff_id), role: String(e.role_id), alerts: !!(e.flags & StaffDeptAccess.ALERTS) })),
          ],
        },
      ],
    },
  ];
}
