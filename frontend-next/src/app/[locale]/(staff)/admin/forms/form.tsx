import "server-only";

import { getTranslations } from "next-intl/server";

import { Callout, Hidden, Section, TextAreaField, TextField } from "@/components/adminsys/fields";
import Repeater from "@/components/adminsys/Repeater";
import { db } from "@/server/db";
import { CDATA_FORM_TYPES, FIELD_TYPES, FieldFlag, REQUIREMENT_MODES, type formDetail } from "@/server/domain/adminsys/form";

type Detail = NonNullable<Awaited<ReturnType<typeof formDetail>>>;

/** Descrizione della visibilità di un campo (DynamicFormField::getVisibilityDescription). */
function visibility(flags: number, type: string, t: (k: string) => string): string {
  if (!(flags & FieldFlag.ENABLED)) return t("vis.disabled");
  const out: string[] = [];
  const VIEW = FieldFlag.CLIENT_VIEW | FieldFlag.AGENT_VIEW;
  if (!(flags & VIEW)) out.push(t("vis.hidden"));
  else if (!(flags & FieldFlag.CLIENT_VIEW)) out.push(t("vis.internal"));
  else if (!(flags & FieldFlag.AGENT_VIEW)) out.push(t("vis.endUsers"));
  if (!["break", "info"].includes(type)) {
    out.push(flags & (FieldFlag.CLIENT_REQUIRED | FieldFlag.AGENT_REQUIRED) ? t("vis.required") : t("vis.optional"));
    if (!(flags & (FieldFlag.CLIENT_EDIT | FieldFlag.AGENT_EDIT))) out.push(t("vis.immutable"));
  }
  return out.join(", ");
}

export async function FormFields({ detail }: { detail: Detail | null }) {
  const t = await getTranslations("asys.forms");
  const lists = await db().selectFrom("list").select(["id", "name"]).orderBy("name").execute();
  const typeOptions = [...FIELD_TYPES.map((v) => ({ value: v, label: t(`fieldTypes.${v}`) })), ...lists.map((l) => ({ value: `list-${l.id}`, label: `${t("listPrefix")}: ${l.name}` }))];
  const form = detail?.form;
  const cdata = !!form && CDATA_FORM_TYPES.includes(form.type);
  const vis = (k: string) => t(k);
  return (
    <>
      <Hidden name="do" value={form ? "update" : "add"} />
      {cdata && <Callout tone="warning">{t("ddlNote")}</Callout>}
      <Section title={t("sections.form")}>
        <TextField name="title" label={t("formTitle")} value={form?.title} required wide />
        <TextAreaField name="instructions" label={t("instructions")} value={form?.instructions} rows={3} />
        <TextAreaField name="notes" label={t("notes")} value={form?.notes} rows={3} />
      </Section>
      <Section title={t("sections.fields")} desc={t("fieldsDesc")} grid={false}>
        <Repeater
          columns={[
            { key: "sort", label: t("sort"), kind: "number", className: "w-24" },
            { key: "label", label: t("label"), kind: "text" },
            { key: "type", label: t("type"), kind: "select", options: typeOptions },
            { key: "visibility", label: t("visibility"), kind: "select", options: Object.keys(REQUIREMENT_MODES).map((m) => ({ value: m, label: t(`modes.${m}`) })) },
            { key: "name", label: t("variable"), kind: "text" },
            { key: "delete", label: t("delete"), kind: "checkbox", className: "w-16" },
          ]}
          rows={(detail?.fields ?? []).map((f) => {
            const flags = f.flags ?? 0;
            return {
              key: String(f.id),
              names: { sort: `sort-${f.id}`, label: `label-${f.id}`, type: `type-${f.id}`, name: `name-${f.id}`, delete: `delete-${f.id}` },
              values: { sort: String(f.sort), label: f.label, type: f.type, name: f.name, visibility: visibility(flags, f.type, vis) },
              locked: { type: !!(flags & FieldFlag.MASK_CHANGE), name: !!(flags & FieldFlag.MASK_NAME), delete: !!(flags & FieldFlag.MASK_DELETE) },
            };
          })}
          newNames={{ sort: "sort-new-{i}", label: "label-new-{i}", type: "type-new-{i}", visibility: "visibility-new-{i}", name: "name-new-{i}" }}
          newDefaults={{ type: "text", visibility: "a" }}
          addLabel={t("addField")}
          removeLabel={t("remove")}
          emptyLabel={t("noFields")}
        />
      </Section>
    </>
  );
}

export async function formLabels(fieldIds: number[]): Promise<Record<string, string>> {
  const t = await getTranslations("asys.forms");
  const out: Record<string, string> = { title: t("formTitle") };
  for (const id of fieldIds) out[`field-${id}`] = t("fieldN", { id });
  for (let i = 0; i < 30; i++) out[`new-${i}`] = t("newFieldN", { n: i + 1 });
  return out;
}
