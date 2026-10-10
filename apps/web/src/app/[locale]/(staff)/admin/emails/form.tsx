import "server-only";

import { getTranslations } from "next-intl/server";

import { CheckboxField, Hidden, RadioField, Section, SelectField, TextAreaField, TextField } from "@/components/adminsys/fields";
import Callout from "@/components/common/Callout";
import { db } from "@/server/db";
import { deptOptions, priorityOptions, topicOptions } from "@/server/domain/admin/lookups";

/** Campi del form account email (include/staff/email.inc.php + templates/email-*.tmpl.php). */
export async function EmailFields({ info, isNew }: { info: Record<string, string>; isNew: boolean }) {
  const t = await getTranslations("asys.emails");
  const executor = db();
  const [depts, priorities, topics] = await Promise.all([deptOptions(executor), priorityOptions(executor), topicOptions(executor)]);
  const sysDefault = { value: "0", label: t("systemDefault") };
  const authTypes = [
    { value: "", label: t("selectAuth") },
    { value: "basic", label: t("basicAuth") },
  ];
  const smtpAuth = [
    { value: "mailbox", label: t("sameAsMailbox") },
    { value: "none", label: t("noAuth") },
    { value: "basic", label: t("basicAuth") },
  ];
  const oauth = (v?: string) => (v && v.startsWith("oauth") ? [{ value: v, label: t("oauthConfigured") }] : []);
  return (
    <>
      <Hidden name="do" value={isNew ? "create" : "update"} />
      <Section title={t("sections.account")} desc={t("accountDesc")}>
        <TextField name="email" label={t("email")} value={info.email} type="email" required />
        <TextField name="name" label={t("name")} value={info.name} required />
        <SelectField name="dept_id" label={t("dept")} value={info.dept_id ?? "0"} options={[sysDefault, ...depts.filter((d) => d.ispublic || d.value === info.dept_id)]} />
        <SelectField name="priority_id" label={t("priority")} value={info.priority_id ?? "0"} options={[sysDefault, ...priorities]} />
        <SelectField name="topic_id" label={t("topic")} value={info.topic_id ?? "0"} options={[sysDefault, ...topics.filter((x) => x.active || x.value === info.topic_id)]} />
        <CheckboxField name="noautoresp" label={t("noAutoresp")} checked={info.noautoresp === "1"} />
        <TextAreaField name="notes" label={t("notes")} value={info.notes} />
      </Section>
      {!isNew && (
        <>
          <Section title={t("sections.mailbox")} desc={t("mailboxDesc")}>
            <RadioField
              name="mailbox_active"
              label={t("status")}
              value={info.mailbox_active === "1" ? "1" : "0"}
              options={[
                { value: "1", label: t("enabled") },
                { value: "0", label: t("disabled") },
              ]}
            />
            <SelectField
              name="mailbox_protocol"
              label={t("protocol")}
              value={info.mailbox_protocol ?? ""}
              options={[{ value: "", label: t("selectProtocol") }, { value: "IMAP", label: "IMAP" }, { value: "POP", label: "POP" }]}
            />
            <TextField name="mailbox_host" label={t("host")} value={info.mailbox_host} />
            <TextField name="mailbox_port" label={t("port")} value={info.mailbox_port === "0" ? "" : info.mailbox_port} type="number" />
            <TextField name="mailbox_folder" label={t("folder")} value={info.mailbox_folder} placeholder="INBOX" />
            <SelectField name="mailbox_auth_bk" label={t("auth")} value={info.mailbox_auth_bk ?? ""} options={[...authTypes, ...oauth(info.mailbox_auth_bk)]} hint={t("authHint")} />
            <TextField name="mailbox_fetchfreq" label={t("fetchFreq")} value={info.mailbox_fetchfreq ?? "5"} type="number" />
            <TextField name="mailbox_fetchmax" label={t("fetchMax")} value={info.mailbox_fetchmax ?? "30"} type="number" />
            <SelectField
              name="mailbox_postfetch"
              label={t("postfetch")}
              value={info.mailbox_postfetch === "nothing" && !info.mailbox_id ? "" : (info.mailbox_postfetch ?? "")}
              options={[
                { value: "", label: t("selectAction") },
                { value: "archive", label: t("archive") },
                { value: "delete", label: t("deleteFetched") },
                { value: "nothing", label: t("doNothing") },
              ]}
            />
            <TextField name="mailbox_archivefolder" label={t("archiveFolder")} value={info.mailbox_archivefolder} />
          </Section>
          <Section title={t("sections.smtp")} desc={t("smtpDesc")}>
            <RadioField
              name="smtp_active"
              label={t("status")}
              value={info.smtp_active === "1" ? "1" : "0"}
              options={[
                { value: "1", label: t("enabled") },
                { value: "0", label: t("disabled") },
              ]}
            />
            <SelectField name="smtp_auth_bk" label={t("auth")} value={info.smtp_auth_bk || "mailbox"} options={[...smtpAuth, ...oauth(info.smtp_auth_bk)]} hint={t("authHint")} />
            <TextField name="smtp_host" label={t("host")} value={info.smtp_host} />
            <TextField name="smtp_port" label={t("port")} value={info.smtp_port === "0" ? "" : info.smtp_port} type="number" />
            <CheckboxField name="smtp_allow_spoofing" label={t("allowSpoofing")} checked={info.smtp_allow_spoofing === "1"} />
          </Section>
          <Callout tone="info">{t("oauthNote")}</Callout>
        </>
      )}
    </>
  );
}

/** Etichette dei campi per gli errori di SysForm. */
export async function emailLabels(): Promise<Record<string, string>> {
  const t = await getTranslations("asys.emails");
  return {
    email: t("email"),
    name: t("name"),
    mailbox_host: `${t("sections.mailbox")} — ${t("host")}`,
    mailbox_port: `${t("sections.mailbox")} — ${t("port")}`,
    mailbox_protocol: `${t("sections.mailbox")} — ${t("protocol")}`,
    mailbox_auth_bk: `${t("sections.mailbox")} — ${t("auth")}`,
    mailbox_fetchfreq: t("fetchFreq"),
    mailbox_fetchmax: t("fetchMax"),
    mailbox_folder: t("folder"),
    mailbox_postfetch: t("postfetch"),
    mailbox_archivefolder: t("archiveFolder"),
    mailbox_auth: t("sections.mailbox"),
    smtp_host: `${t("sections.smtp")} — ${t("host")}`,
    smtp_port: `${t("sections.smtp")} — ${t("port")}`,
    smtp_auth_bk: `${t("sections.smtp")} — ${t("auth")}`,
    smtp_auth: t("sections.smtp"),
    username: t("username"),
    passwd: t("password"),
  };
}
