import { getTranslations, setRequestLocale } from "next-intl/server";

import { CheckboxField, Section, SelectField, TextField } from "@/components/adminsys/fields";
import SysForm from "@/components/adminsys/SysForm";
import { PageHeader } from "@/components/common/DataTable";
import { db } from "@/server/db";
import { emailOptions, templateOptions } from "@/server/domain/admin/lookups";
import { emailsSettingsValues } from "@/server/domain/adminsys/email-settings";

import { requireAdmin } from "../../guard";
import { saveEmailsSettingsAction } from "./actions";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("emailSettings");

/** Impostazioni email (include/staff/settings-emails.inc.php). */
export default async function EmailSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("asys.emailSettings");
  const executor = db();
  const [cfg, emails, templates, smtp] = await Promise.all([
    emailsSettingsValues(executor),
    emailOptions(executor),
    templateOptions(executor),
    executor
      .selectFrom("email_account as a")
      .innerJoin("email as e", "e.email_id", "a.email_id")
      .select(["a.id", "e.email", "a.host", "a.port", "a.active"])
      .where("a.type", "=", "smtp")
      .execute(),
  ]);
  const on = (k: string) => !!cfg[k] && cfg[k] !== "0";
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <SysForm
        action={saveEmailsSettingsAction}
        labels={{
          default_template_id: t("template"),
          default_email_id: t("defaultEmail"),
          alert_email_id: t("alertEmail"),
          admin_email: t("adminEmail"),
          reply_separator: t("replySeparator"),
        }}
      >
        <Section title={t("sections.general")}>
          <SelectField name="default_template_id" label={t("template")} value={cfg.default_template_id} options={[{ value: "", label: t("selectTemplate") }, ...templates]} />
          <SelectField name="default_email_id" label={t("defaultEmail")} value={cfg.default_email_id} options={[{ value: "0", label: t("selectOne"), disabled: true }, ...emails]} />
          <SelectField name="alert_email_id" label={t("alertEmail")} value={cfg.alert_email_id} options={[{ value: "0", label: t("useDefault") }, ...emails]} />
          <TextField name="admin_email" label={t("adminEmail")} value={cfg.admin_email} type="email" />
          <CheckboxField name="verify_email_addrs" label={t("verifyAddrs")} checked={on("verify_email_addrs")} value="on" />
        </Section>
        <Section title={t("sections.incoming")}>
          <CheckboxField name="enable_mail_polling" label={t("polling")} checked={on("enable_mail_polling")} />
          <CheckboxField name="enable_auto_cron" label={t("autoCron")} checked={on("enable_auto_cron")} value="on" />
          <CheckboxField name="strip_quoted_reply" label={t("stripQuoted")} checked={on("strip_quoted_reply")} value="on" />
          <TextField name="reply_separator" label={t("replySeparator")} value={cfg.reply_separator} />
          <CheckboxField name="use_email_priority" label={t("emailPriority")} checked={on("use_email_priority")} />
          <CheckboxField name="accept_unregistered_email" label={t("acceptUnregistered")} checked={on("accept_unregistered_email")} value="on" />
          <CheckboxField name="add_email_collabs" label={t("addCollabs")} checked={on("add_email_collabs")} value="on" />
        </Section>
        <Section title={t("sections.outgoing")}>
          <SelectField
            name="default_smtp_id"
            label={t("defaultMta")}
            value={cfg.default_smtp_id || "0"}
            options={[{ value: "0", label: t("phpMail") }, ...smtp.map((s) => ({ value: String(s.id), label: `${s.email} (${s.host}:${s.port})${s.active ? "" : ` — ${t("inactive")}`}` }))]}
            hint={t("defaultMtaHint")}
          />
          <CheckboxField name="email_attachments" label={t("attachments")} checked={on("email_attachments")} value="on" />
        </Section>
      </SysForm>
    </div>
  );
}
