import "server-only";

import { getTranslations } from "next-intl/server";

import type { FormSection } from "@/lib/admin/form-schema";
import { StaffDeptAccess, TeamMember } from "@/lib/osticket/flags";
import { db } from "@/server/db";
import { deptOptions, roleOptions, teamOptions } from "@/server/domain/admin/lookups";
import { AGENT_PERMISSIONS } from "@/server/domain/admin/staff-admin";
import { phpJsonDecode } from "@/server/format/php-json";

/** Sezioni del form agente (include/staff/staff.inc.php). */
export async function agentSections(staffId: number | null): Promise<FormSection[] | null> {
  const t = await getTranslations("admAgents");
  const r = await getTranslations("admRoles");
  const executor = db();
  const s = staffId ? await executor.selectFrom("staff").selectAll().where("staff_id", "=", staffId).executeTakeFirst() : null;
  if (staffId && !s) return null;
  const [depts, roles, teams] = await Promise.all([deptOptions(executor), roleOptions(executor), teamOptions(executor)]);
  const access = staffId ? await executor.selectFrom("staff_dept_access").select(["dept_id", "role_id", "flags"]).where("staff_id", "=", staffId).execute() : [];
  const memberships = staffId ? await executor.selectFrom("team_member").select(["team_id", "flags"]).where("staff_id", "=", staffId).execute() : [];
  const perms = phpJsonDecode<Record<string, unknown>>(s?.permissions ?? "", {}) ?? {};
  const extra = phpJsonDecode<Record<string, unknown>>(s?.extra ?? "", {}) ?? {};
  const groups = [...new Set(AGENT_PERMISSIONS.map((p) => p.group))];
  const sections: FormSection[] = [
    {
      title: t("sections.account"),
      fields: [
        { kind: "hidden", name: "do", value: staffId ? "update" : "create" },
        { kind: "hidden", name: "id", value: staffId ? String(staffId) : "" },
        { kind: "text", name: "firstname", label: t("firstname"), value: s?.firstname ?? "", required: true },
        { kind: "text", name: "lastname", label: t("lastname"), value: s?.lastname ?? "", required: true },
        { kind: "email", name: "email", label: t("email"), value: s?.email ?? "", required: true },
        { kind: "text", name: "username", label: t("username"), value: s?.username ?? "", required: true },
        { kind: "text", name: "phone", label: t("phone"), value: s?.phone ?? "" },
        { kind: "text", name: "phone_ext", label: t("phoneExt"), value: s?.phone_ext ?? "" },
        { kind: "text", name: "mobile", label: t("mobile"), value: s?.mobile ?? "" },
        {
          kind: "select",
          name: "backend",
          label: t("backend"),
          value: s?.backend ?? "",
          options: [
            { value: "", label: t("anyBackend") },
            { value: "local", label: t("localBackend") },
          ],
        },
      ],
    },
    {
      title: t("sections.status"),
      desc: t("statusDesc"),
      fields: [
        { kind: "checkbox", name: "islocked", value: "1", label: t("locked"), checked: s ? !s.isactive : false },
        { kind: "checkbox", name: "isadmin", value: "1", label: t("admin"), checked: !!s?.isadmin },
        { kind: "checkbox", name: "assigned_only", label: t("assignedOnly"), checked: !!s?.assigned_only },
        { kind: "checkbox", name: "onvacation", label: t("onVacation"), checked: !!s?.onvacation },
      ],
    },
    {
      title: t("sections.access"),
      fields: [
        { kind: "select", name: "dept_id", label: t("primaryDept"), value: s ? String(s.dept_id) : "", options: [{ value: "", label: t("chooseDept") }, ...depts.filter((d) => d.active || String(s?.dept_id) === d.value)] },
        { kind: "select", name: "role_id", label: t("primaryRole"), value: s ? String(s.role_id) : "", options: [{ value: "", label: t("chooseRole") }, ...roles] },
        { kind: "checkbox", name: "assign_use_pri_role", label: t("usePrimaryRole"), checked: !!extra.def_assn_role, wide: true },
        {
          kind: "access",
          name: "dept_access",
          label: t("extendedAccess"),
          ids: "dept_access",
          role: "dept_access_role",
          alerts: "dept_access_alerts",
          choices: depts,
          roles,
          wide: true,
          selected: access.map((a) => ({ id: String(a.dept_id), role: String(a.role_id), alerts: !!(a.flags & StaffDeptAccess.ALERTS) })),
        },
      ],
    },
    {
      title: t("sections.perms"),
      fields: [
        {
          kind: "checkboxes",
          name: "perms[]",
          label: t("perms"),
          wide: true,
          options: [],
          values: Object.entries(perms).filter(([, v]) => !!v).map(([k]) => k),
          groups: groups.map((g) => ({
            title: r.has(`groups.${g}`) ? r(`groups.${g}`) : g,
            options: AGENT_PERMISSIONS.filter((p) => p.group === g).map((p) => ({ value: p.key, label: `${p.title} — ${p.desc}` })),
          })),
        },
      ],
    },
    {
      title: t("sections.teams"),
      fields: [
        {
          kind: "access",
          name: "teams",
          label: t("teams"),
          ids: "teams",
          alerts: "team_alerts",
          choices: teams,
          wide: true,
          selected: memberships.map((m) => ({ id: String(m.team_id), alerts: !!(m.flags & TeamMember.ALERTS) })),
        },
        { kind: "textarea", name: "notes", label: t("notes"), value: s?.notes ?? "", rows: 3, wide: true },
      ],
    },
  ];
  if (!staffId) {
    sections.push({
      title: t("sections.password"),
      desc: t("passwordDesc"),
      fields: [
        { kind: "checkbox", name: "welcome_email", label: t("sendWelcome"), checked: true, wide: true },
        { kind: "password", name: "passwd1", label: t("newPassword") },
        { kind: "password", name: "passwd2", label: t("confirmPassword") },
        { kind: "checkbox", name: "change_passwd", label: t("requireChange"), checked: true },
      ],
    });
  }
  return sections;
}

/** Form "Imposta password" (ajax.staff.php setPassword) per un agente esistente. */
export async function passwordSections(): Promise<FormSection[]> {
  const t = await getTranslations("admAgents");
  return [
    {
      title: t("sections.resetPassword"),
      desc: t("resetDesc"),
      fields: [
        { kind: "checkbox", name: "welcome_email", label: t("sendReset"), checked: true, wide: true },
        { kind: "password", name: "passwd1", label: t("newPassword") },
        { kind: "password", name: "passwd2", label: t("confirmPassword") },
        { kind: "checkbox", name: "change_passwd", label: t("requireChange"), checked: true },
      ],
    },
  ];
}
