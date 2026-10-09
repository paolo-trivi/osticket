import { getTranslations, setRequestLocale } from "next-intl/server";

import { Section, SelectField, TextAreaField, TextField } from "@/components/adminsys/fields";
import SysForm from "@/components/adminsys/SysForm";
import { PageHeader } from "@/components/common/DataTable";
import { db } from "@/server/db";
import { emailOptions } from "@/server/domain/admin/lookups";

import { requireAdmin } from "../../guard";
import { sendTestEmailAction } from "../actions";

/** Diagnostica: email di prova (scp/emailtest.php). */
export default async function EmailDiagnosticPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("asys.diagnostic");
  const emails = await emailOptions(db());
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <SysForm action={sendTestEmailAction} submitLabel={t("send")} savedMessage={t("sent")} labels={{ email_id: t("from"), email: t("to"), subj: t("subject"), body: t("body") }}>
        <Section title={t("section")}>
          <SelectField name="email_id" label={t("from")} value="0" options={[{ value: "0", label: t("selectFrom") }, ...emails]} />
          <TextField name="email" label={t("to")} type="email" />
          <TextField name="subj" label={t("subject")} value="osTicket test email" wide />
          <TextAreaField name="body" label={t("body")} rows={8} hint={t("bodyHint")} />
        </Section>
      </SysForm>
    </div>
  );
}
