import "server-only";

import { getTranslations } from "next-intl/server";

import { CheckboxField, Hidden, InfoText, RadioField, Section, TextAreaField, TextField } from "@/components/adminsys/fields";

/** Campi della chiave API (include/staff/apikey.inc.php). */
export async function ApiKeyFields({ k }: { k: { apikey: string; ipaddr: string; isactive: number; can_create_tickets: number; can_exec_cron: number; notes: string | null } | null }) {
  const t = await getTranslations("asys.apikeys");
  const c = await getTranslations("asys.common");
  return (
    <>
      <Hidden name="do" value={k ? "update" : "add"} />
      <Section title={t("sections.key")}>
        <RadioField
          name="isactive"
          label={t("status")}
          value={k ? String(k.isactive ? 1 : 0) : "1"}
          options={[
            { value: "1", label: c("active") },
            { value: "0", label: c("disabled") },
          ]}
        />
        {k ? (
          <>
            <InfoText label={t("ip")}>{k.ipaddr}</InfoText>
            <InfoText label={t("key")} wide>
              <code className="font-mono text-theme-xs">{k.apikey}</code>
            </InfoText>
          </>
        ) : (
          <TextField name="ipaddr" label={t("ip")} hint={t("ipHint")} required />
        )}
        <CheckboxField name="can_create_tickets" label={t("canCreate")} checked={k ? !!k.can_create_tickets : true} />
        <CheckboxField name="can_exec_cron" label={t("canCron")} checked={k ? !!k.can_exec_cron : true} />
        <TextAreaField name="notes" label={t("notes")} value={k?.notes} rows={3} />
      </Section>
    </>
  );
}
