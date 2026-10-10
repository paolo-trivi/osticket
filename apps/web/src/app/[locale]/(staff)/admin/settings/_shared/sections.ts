import "server-only";

import { getTranslations } from "next-intl/server";

import type { FormField, FormSection, Opt } from "@/lib/admin/form-schema";
import { db } from "@/server/db";
import { companyValues } from "@/server/domain/admin/company";
import {
  brandingFiles,
  deptOptions,
  pageOptions,
  priorityOptions,
  queueOptions,
  scheduleOptions,
  sequenceOptions,
  slaOptions,
  statusOptions,
  timezoneOptions,
  topicOptions,
} from "@/server/domain/admin/lookups";
import { installedLanguages } from "@/server/domain/admin/languages";
import { settingsValues, type SettingsPage } from "@/server/domain/admin/settings";

/** Valore "vero" di una impostazione salvata come 1/""/on. */
const on = (v: string | undefined) => !!v && v !== "0";

const NAME_FORMATS = ["full", "first", "last", "legal", "lastfirst", "formal", "short", "shortformal", "complete", "original"];
const AVATARS: Opt[] = [
  { value: "local", label: "Built-In" },
  ...["mm", "identicon", "monsterid", "wavatar", "retro", "blank"].map((m) => ({ value: `gravatar.${m}`, label: `Gravatar / ${m}` })),
];

/**
 * Sezioni dei form impostazioni (include/staff/settings-*.inc.php) con i valori correnti della config
 * "core" (più i default di OsticketConfig). Le chiavi dei campi sono quelle del POST di scp/settings.php.
 */
export async function settingsSections(page: SettingsPage): Promise<FormSection[]> {
  const t = await getTranslations("admSettings");
  const c = await settingsValues(db());
  const yes = (name: string, label: string, hint?: string, wide = false): FormField => ({ kind: "checkbox", name, label, checked: on(c[name]), hint, wide });
  const text = (name: string, label: string, hint?: string): FormField => ({ kind: "text", name, label, value: c[name] ?? "", hint });
  const num = (name: string, label: string, hint?: string): FormField => ({ kind: "number", name, label, value: c[name] ?? "", hint });
  const sel = (name: string, label: string, options: Opt[], hint?: string): FormField => ({ kind: "select", name, label, value: c[name] ?? "", options, hint });

  switch (page) {
    case "system": {
      const [depts, schedules] = await Promise.all([deptOptions(), scheduleOptions(db(), "bizhrs")]);
      const langs = installedLanguages().map((l) => ({ value: l.replace(/_(\w+)$/, (_m, r: string) => `_${r.toUpperCase()}`), label: l }));
      return [
        {
          title: t("sections.general"),
          fields: [
            {
              kind: "radio",
              name: "isonline",
              label: t("isonline"),
              value: on(c.isonline) ? "1" : "0",
              options: [
                { value: "1", label: t("online") },
                { value: "0", label: t("offline") },
              ],
            },
            text("helpdesk_url", t("helpdesk_url")),
            text("helpdesk_title", t("helpdesk_title")),
            sel("default_dept_id", t("default_dept_id"), depts.filter((d) => d.active)),
            sel("schedule_id", t("schedule_id"), [{ value: "0", label: t("none") }, ...schedules]),
            { kind: "checkbox", name: "force_https", label: t("force_https"), checked: c.force_https === "on" },
            sel("max_page_size", t("max_page_size"), Array.from({ length: 10 }, (_, i) => ({ value: String((i + 1) * 5), label: String((i + 1) * 5) }))),
            sel("log_level", t("log_level"), ["0", "3", "2", "1"].map((v) => ({ value: v, label: t(`logLevels.${v}`) }))),
            sel("log_graceperiod", t("log_graceperiod"), [{ value: "0", label: t("neverPurge") }, ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: t("months", { n: i + 1 }) }))]),
            num("autolock_minutes", t("autolock_minutes")),
            yes("enable_avatars", t("enable_avatars")),
            yes("enable_richtext", t("enable_richtext")),
            yes("files_req_auth", t("files_req_auth")),
            sel("default_storage_bk", t("default_storage_bk"), [{ value: "D", label: t("storageDb") }]),
            sel(
              "max_file_size",
              t("max_file_size"),
              [262144, 524288, 1048576, 2097152, 4194304, 8388608, 16777216, 33554432].map((b) => ({ value: String(b), label: `${b / 1048576} MB` })),
            ),
          ],
        },
        {
          title: t("sections.security"),
          fields: [
            { kind: "text", name: "allow_iframes", label: t("allow_iframes"), value: c.allow_iframes ?? "", hint: t("csvHint"), wide: true },
            { kind: "text", name: "embedded_domain_whitelist", label: t("embedded_domain_whitelist"), value: c.embedded_domain_whitelist ?? "", hint: t("csvHint"), wide: true },
            { kind: "text", name: "acl", label: t("acl"), value: c.acl ?? "", hint: t("aclHint"), wide: true },
            sel("acl_backend", t("acl_backend"), ["0", "1", "2", "3"].map((v) => ({ value: v, label: t(`aclBackends.${v}`) }))),
          ],
        },
        {
          title: t("sections.datetime"),
          fields: [
            sel("default_timezone", t("default_timezone"), timezoneOptions()),
            sel("date_formats", t("date_formats"), [
              { value: "", label: t("localeDefaults") },
              { value: "24", label: t("localeDefaults24") },
              { value: "custom", label: t("advanced") },
            ]),
            text("time_format", t("time_format")),
            text("date_format", t("date_format")),
            text("datetime_format", t("datetime_format")),
            text("daydatetime_format", t("daydatetime_format")),
            text("default_locale", t("default_locale"), t("localeHint")),
          ],
        },
        {
          title: t("sections.languages"),
          fields: [
            sel("system_language", t("system_language"), langs),
            {
              kind: "checkboxes",
              name: "secondary_langs[]",
              label: t("secondary_langs"),
              values: (c.secondary_langs ?? "").split(",").filter(Boolean),
              options: langs,
              wide: true,
            },
          ],
        },
      ];
    }
    case "tickets": {
      const [priorities, topics, statuses, slas, queues, sequences] = await Promise.all([
        priorityOptions(),
        topicOptions(),
        statusOptions(db(), ["open"]),
        slaOptions(),
        queueOptions(),
        sequenceOptions(),
      ]);
      const topQueues = queues.filter((q) => q.parent === 0);
      const alertBox = (key: string, recipients: string[]): FormField[] => [
        {
          kind: "radio",
          name: `${key}_active`,
          label: t(`alerts.${key}`),
          value: on(c[`${key}_active`]) ? "1" : "0",
          options: [
            { value: "1", label: t("enable") },
            { value: "0", label: t("disable") },
          ],
        },
        ...recipients.map((r) => yes(`${key}_${r}`, t(`recipients.${r}`))),
      ];
      return [
        {
          title: t("sections.tickets"),
          fields: [
            text("ticket_number_format", t("number_format"), t("numberFormatHint")),
            sel("ticket_sequence_id", t("sequence"), [{ value: "0", label: t("random") }, ...sequences]),
            sel("default_ticket_status_id", t("default_ticket_status_id"), statuses),
            sel("default_priority_id", t("default_priority_id"), priorities),
            sel("default_sla_id", t("default_sla_id"), [{ value: "0", label: t("none") }, ...slas]),
            sel("default_help_topic", t("default_help_topic"), [{ value: "0", label: t("none") }, ...topics.filter((x) => x.active)]),
            sel("default_ticket_queue", t("default_ticket_queue"), topQueues),
            num("max_open_tickets", t("max_open_tickets"), t("zeroUnlimited")),
            sel("ticket_lock", t("ticket_lock"), ["0", "1", "2"].map((v) => ({ value: v, label: t(`lockModes.${v}`) }))),
            yes("queue_bucket_counts", t("queue_bucket_counts")),
            yes("enable_captcha", t("enable_captcha")),
            yes("auto_claim_tickets", t("auto_claim_tickets")),
            yes("auto_refer_closed", t("auto_refer_closed")),
            yes("collaborator_ticket_visibility", t("collaborator_ticket_visibility")),
            yes("require_topic_to_close", t("require_topic_to_close")),
            yes("show_related_tickets", t("show_related_tickets")),
            yes("allow_client_updates", t("allow_client_updates")),
            yes("allow_external_images", t("allow_external_images")),
          ],
        },
        {
          title: t("sections.autoresp"),
          fields: [
            yes("ticket_autoresponder", t("ticket_autoresponder")),
            yes("message_autoresponder", t("message_autoresponder")),
            yes("message_autoresponder_collabs", t("message_autoresponder_collabs")),
            yes("ticket_notice_active", t("ticket_notice_active")),
            yes("overlimit_notice_active", t("overlimit_notice_active")),
          ],
        },
        {
          title: t("sections.alerts"),
          fields: [
            ...alertBox("ticket_alert", ["admin", "dept_manager", "dept_members", "acct_manager"]),
            ...alertBox("message_alert", ["laststaff", "assigned", "dept_manager", "acct_manager"]),
            ...alertBox("note_alert", ["laststaff", "assigned", "dept_manager"]),
            ...alertBox("assigned_alert", ["staff", "team_lead", "team_members"]),
            ...alertBox("transfer_alert", ["assigned", "dept_manager", "dept_members"]),
            ...alertBox("overdue_alert", ["assigned", "dept_manager", "dept_members"]),
            yes("send_sys_errors", t("send_sys_errors")),
            yes("send_sql_errors", t("send_sql_errors")),
            yes("send_login_errors", t("send_login_errors")),
          ],
        },
        {
          title: t("sections.queues"),
          desc: t("queuesDesc"),
          fields: topQueues.map((q) => ({ kind: "number" as const, name: `qsort[${q.value}]`, label: q.label, value: String(q.sort) })),
        },
      ];
    }
    case "tasks": {
      const [priorities, slas, sequences] = await Promise.all([priorityOptions(), slaOptions(), sequenceOptions()]);
      const alertBox = (key: string, recipients: string[]): FormField[] => [
        {
          kind: "radio",
          name: `${key}_active`,
          label: t(`taskAlerts.${key}`),
          value: on(c[`${key}_active`]) ? "1" : "0",
          options: [
            { value: "1", label: t("enable") },
            { value: "0", label: t("disable") },
          ],
        },
        ...recipients.map((r) => yes(`${key}_${r}`, t(`recipients.${r}`))),
      ];
      return [
        {
          title: t("sections.tasks"),
          fields: [
            text("task_number_format", t("number_format"), t("numberFormatHint")),
            sel("task_sequence_id", t("sequence"), [{ value: "0", label: t("random") }, ...sequences]),
            sel("default_task_priority_id", t("default_priority_id"), priorities),
            sel("default_task_sla_id", t("default_sla_id"), [{ value: "0", label: t("none") }, ...slas]),
          ],
        },
        {
          title: t("sections.alerts"),
          fields: [
            ...alertBox("task_alert", ["admin", "dept_manager", "dept_members"]),
            ...alertBox("task_activity_alert", ["laststaff", "assigned", "dept_manager"]),
            ...alertBox("task_assignment_alert", ["staff", "team_lead", "team_members"]),
            ...alertBox("task_transfer_alert", ["assigned", "dept_manager", "dept_members"]),
            ...alertBox("task_overdue_alert", ["assigned", "dept_manager", "dept_members"]),
          ],
        },
      ];
    }
    case "agents":
      return [
        {
          title: t("sections.agents"),
          fields: [
            sel("agent_name_format", t("name_format"), NAME_FORMATS.map((f) => ({ value: f, label: t(`nameFormats.${f}`) }))),
            sel("agent_avatar", t("avatar"), AVATARS),
            yes("hide_staff_name", t("hide_staff_name")),
            yes("disable_agent_collabs", t("disable_agent_collabs")),
          ],
        },
        {
          title: t("sections.auth"),
          fields: [
            sel("agent_passwd_policy", t("passwd_policy"), [
              { value: " ", label: t("allPolicies") },
              { value: "basic", label: t("basicPolicy") },
            ]),
            yes("allow_pw_reset", t("allow_pw_reset")),
            num("pw_reset_window", t("pw_reset_window"), t("minutes")),
            yes("require_agent_2fa", t("require_agent_2fa")),
            num("staff_max_logins", t("max_logins")),
            num("staff_login_timeout", t("login_timeout"), t("minutes")),
            num("staff_session_timeout", t("session_timeout"), t("minutesZero")),
            yes("staff_ip_binding", t("staff_ip_binding")),
          ],
        },
      ];
    case "users":
      return [
        {
          title: t("sections.users"),
          fields: [
            sel("client_name_format", t("name_format"), NAME_FORMATS.map((f) => ({ value: f, label: t(`nameFormats.${f}`) }))),
            sel("client_avatar", t("avatar"), AVATARS),
          ],
        },
        {
          title: t("sections.auth"),
          fields: [
            sel("client_registration", t("client_registration"), ["disabled", "public", "closed"].map((v) => ({ value: v, label: t(`registration.${v}`) }))),
            yes("clients_only", t("clients_only")),
            yes("client_verify_email", t("client_verify_email")),
            yes("allow_auth_tokens", t("allow_auth_tokens")),
            sel("client_passwd_policy", t("passwd_policy"), [
              { value: " ", label: t("allPolicies") },
              { value: "basic", label: t("basicPolicy") },
            ]),
            num("client_max_logins", t("max_logins")),
            num("client_login_timeout", t("login_timeout"), t("minutes")),
            num("client_session_timeout", t("session_timeout"), t("minutesZero")),
          ],
        },
      ];
    case "kb":
      return [
        {
          title: t("sections.kb"),
          fields: [yes("enable_kb", t("enable_kb")), yes("restrict_kb", t("restrict_kb")), yes("enable_premade", t("enable_premade"))],
        },
      ];
    case "pages": {
      const [company, landing, offline, thanks, files] = await Promise.all([
        companyValues(db()),
        pageOptions(db(), "landing"),
        pageOptions(db(), "offline"),
        pageOptions(db(), "thank-you"),
        brandingFiles(),
      ]);
      const pick = (name: string, cur: string | undefined, list: Opt[], def: string): FormField => ({
        kind: "radio",
        name,
        label: t(`logo.${name}`),
        value: cur && cur !== "0" ? cur : "0",
        options: [{ value: "0", label: def }, ...list],
        wide: true,
      });
      return [
        {
          title: t("sections.company"),
          fields: company.fields
            .filter((f) => f.type !== "break" && f.type !== "info")
            .map<FormField>((f) =>
              f.type === "memo"
                ? { kind: "textarea", name: f.name || String(f.id), label: f.label, value: company.values[f.name || String(f.id)] ?? "", rows: 3, wide: true }
                : { kind: "text", name: f.name || String(f.id), label: f.label, value: company.values[f.name || String(f.id)] ?? "" },
            ),
        },
        {
          title: t("sections.pages"),
          fields: [sel("landing_page_id", t("landing_page_id"), landing), sel("offline_page_id", t("offline_page_id"), offline), sel("thank-you_page_id", t("thank_you_page_id"), thanks)],
        },
        {
          title: t("sections.logos"),
          desc: t("logosDesc"),
          fields: [
            pick("selected-logo", c.client_logo_id, files.logos, t("logo.defaultLogo")),
            pick("selected-logo-scp", c.staff_logo_id, files.logos, t("logo.defaultLogo")),
            pick("selected-backdrop", c.staff_backdrop_id, files.backdrops, t("logo.defaultBackdrop")),
          ],
        },
      ];
    }
  }
}
