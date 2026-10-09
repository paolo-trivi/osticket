import "server-only";

import { getTranslations } from "next-intl/server";

import { Hidden, RadioField, Section, SelectField, TextAreaField, TextField } from "@/components/adminsys/fields";
import { PAGE_TYPES } from "@/server/domain/adminsys/page";

/** Campi della pagina (include/staff/page.inc.php). Le traduzioni restano al pannello PHP. */
export async function PageFields({ page }: { page: { id: number; name: string; type: string; isactive: number; body: string; notes: string | null } | null }) {
  const t = await getTranslations("asys.pages");
  const c = await getTranslations("asys.common");
  return (
    <>
      <Hidden name="do" value={page ? "update" : "add"} />
      <Section title={t("sections.page")}>
        <TextField name="name" label={t("name")} value={page?.name} required />
        <SelectField
          name="type"
          label={t("type")}
          value={page?.type ?? ""}
          options={[{ value: "", label: t("selectType") }, ...(page && !(PAGE_TYPES as readonly string[]).includes(page.type) ? [{ value: page.type, label: page.type }] : []), ...PAGE_TYPES.map((v) => ({ value: v, label: t(`types.${v}`) }))]}
        />
        <RadioField
          name="isactive"
          label={t("status")}
          value={page ? String(page.isactive ? 1 : 0) : "1"}
          options={[
            { value: "1", label: c("active") },
            { value: "0", label: c("disabled") },
          ]}
        />
      </Section>
      <Section title={t("sections.body")} grid={false}>
        <TextAreaField name="body" label={t("body")} value={page?.body} rows={14} mono hint={t("bodyHint")} />
      </Section>
      <Section title={t("sections.notes")} grid={false}>
        <TextAreaField name="notes" label={t("notes")} value={page?.notes} rows={3} />
      </Section>
    </>
  );
}
