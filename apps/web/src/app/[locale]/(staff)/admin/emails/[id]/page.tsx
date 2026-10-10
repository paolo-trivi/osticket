import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import { Hidden, InfoText, Section, SelectField, TextField } from "@/components/adminsys/fields";
import SysForm from "@/components/adminsys/SysForm";
import SysNotice from "@/components/adminsys/SysNotice";
import { PageHeader } from "@/components/common/DataTable";
import { idOrNotFound } from "@/lib/route-id";
import { db } from "@/server/db";
import { emailInfo } from "@/server/domain/adminsys/email";

import { requireAdmin } from "../../guard";
import { saveEmailAction, saveEmailAuthAction } from "../actions";
import { EmailFields, emailLabels } from "../form";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("emailAccounts");

/**
 * Modifica di un account email con le credenziali "basic" di mailbox e SMTP. I form delle credenziali
 * ripetono campi del form principale (host, porta, protocollo) e tra loro (utente, password): id espliciti
 * cred-<tipo>-<campo>, perché gli id derivati dal nome sarebbero duplicati nella pagina.
 */
export default async function EditEmailPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const emailId = idOrNotFound(id);
  const info = await emailInfo(db(), emailId);
  if (!info) notFound();
  const t = await getTranslations("asys.emails");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  const labels = await emailLabels();
  return (
    <div className="space-y-6">
      <PageHeader title={info.name ? `${info.name} <${info.email}>` : info.email} subtitle={t("edit")} actions={<BackLink href="/admin/emails" label={c("back")} />} />
      <SysNotice sp={sp} />
      <SysForm action={saveEmailAction.bind(null, emailId)} labels={labels}>
        <EmailFields info={info} isNew={false} />
      </SysForm>
      {(["mailbox", "smtp"] as const).map((type) => (
        <SysForm key={type} action={saveEmailAuthAction.bind(null, emailId, type)} labels={labels} submitLabel={t("saveCredentials")} resetOnSave>
          <Section title={t(`authTitle.${type}`)} desc={t("authDesc")}>
            <InfoText label={t("currentAuth")}>{info[`${type}_auth_bk`] || "—"}</InfoText>
            <InfoText label={t("errorsCount")}>
              {info[`${type}_num_errors`] ?? "0"}
              {info[`${type}_last_error_msg`] ? ` — ${info[`${type}_last_error_msg`]}` : ""}
            </InfoText>
            <TextField id={`cred-${type}-host`} name={`${type}_host`} label={t("host")} value={info[`${type}_host`]} />
            <TextField id={`cred-${type}-port`} name={`${type}_port`} label={t("port")} value={info[`${type}_port`] === "0" ? "" : info[`${type}_port`]} type="number" />
            {type === "mailbox" ? (
              <SelectField id="cred-mailbox-protocol" name="mailbox_protocol" label={t("protocol")} value={info.mailbox_protocol ?? ""} options={[{ value: "", label: t("selectProtocol") }, { value: "IMAP", label: "IMAP" }, { value: "POP", label: "POP" }]} />
            ) : (
              <Hidden name="smtp_protocol" value={info.smtp_protocol ?? ""} />
            )}
            <TextField id={`cred-${type}-username`} name="username" label={t("username")} value={info[`${type}_username`] ?? info.email} />
            <TextField id={`cred-${type}-passwd`} name="passwd" label={t("password")} type="password" hint={info[`${type}_has_password`] ? t("passwordHint") : undefined} />
          </Section>
        </SysForm>
      ))}
    </div>
  );
}
