import "server-only";

import { getTranslations } from "next-intl/server";

import { Hidden, InfoText, RadioField, Section, SelectField, TextAreaField, TextField } from "@/components/adminsys/fields";
import { installedLanguages } from "@/server/domain/admin/languages";

/** Campi del set di template (include/staff/template.inc.php). */
export async function TemplateGroupFields({ group, sets }: { group: { tpl_id: number; name: string; isactive: number; lang: string; notes: string | null } | null; sets: { value: string; label: string }[] }) {
  const t = await getTranslations("asys.templates");
  const c = await getTranslations("asys.common");
  const langs = installedLanguages();
  return (
    <Section title={group ? t("editSet") : t("new")}>
      <Hidden name="do" value={group ? "update" : "add"} />
      <TextField name="name" label={t("name")} value={group?.name} required />
      <RadioField
        name="isactive"
        label={t("status")}
        value={group ? String(group.isactive ? 1 : 0) : "1"}
        options={[
          { value: "1", label: c("active") },
          { value: "0", label: c("disabled") },
        ]}
      />
      {group ? (
        <InfoText label={t("language")}>{group.lang}</InfoText>
      ) : (
        <>
          <SelectField name="tpl_id" label={t("cloneFrom")} value="" options={[{ value: "", label: t("stockTemplates") }, ...sets]} hint={t("cloneHint")} />
          <SelectField name="lang_id" label={t("language")} value="en_US" options={langs.map((l) => ({ value: l.replace(/^([a-z]{2})_(\w+)$/, (_m, a: string, b: string) => `${a}_${b.toUpperCase()}`), label: l }))} />
        </>
      )}
      <TextAreaField name="notes" label={t("notes")} value={group?.notes} rows={3} />
    </Section>
  );
}
