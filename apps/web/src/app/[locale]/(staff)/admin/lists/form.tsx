import "server-only";

import { getTranslations } from "next-intl/server";

import { Hidden, Section, SelectField, TextAreaField, TextField } from "@/components/adminsys/fields";
import Repeater from "@/components/adminsys/Repeater";
import { DynamicFormField } from "@/lib/osticket/flags";
import { htmlDecode } from "@/server/format/html";
import { SORT_MODES, type listDetail } from "@/server/domain/adminsys/list";

type Detail = NonNullable<Awaited<ReturnType<typeof listDetail>>>;

const PROP_TYPES = ["text", "memo", "datetime", "phone", "bool", "choices"];

/** Form della lista con le proprietà (include/staff/dynamic-list.inc.php). */
export async function ListFields({ detail }: { detail: Detail | null }) {
  const t = await getTranslations("asys.lists");
  const f = await getTranslations("asys.forms");
  const list = detail?.list;
  const dec = (v: string | null | undefined) => (v ? htmlDecode(v) : v);
  return (
    <>
      <Hidden name="do" value={list ? "update" : "add"} />
      <Section title={t("sections.list")}>
        <TextField name="name" label={t("name")} value={dec(list?.name)} required />
        <TextField name="name_plural" label={t("plural")} value={dec(list?.name_plural)} />
        <SelectField name="sort_mode" label={t("sortMode")} value={list?.sort_mode ?? "Alpha"} options={SORT_MODES.map((m) => ({ value: m, label: t(`sortModes.${m}`) }))} />
        <TextAreaField name="notes" label={t("notes")} value={list?.notes} rows={3} />
      </Section>
      <Section title={t("sections.properties")} desc={t("propertiesDesc")} grid={false}>
        <Repeater
          columns={[
            { key: "sort", label: f("sort"), kind: "number", className: "w-24" },
            { key: "label", label: f("label"), kind: "text" },
            { key: "type", label: f("type"), kind: "select", options: PROP_TYPES.map((v) => ({ value: v, label: f(`fieldTypes.${v}`) })) },
            { key: "name", label: f("variable"), kind: "text" },
            { key: "delete", label: f("delete"), kind: "checkbox", className: "w-16" },
          ]}
          rows={(detail?.properties ?? []).map((p) => {
            const flags = p.flags ?? 0;
            return {
              key: String(p.id),
              names: { sort: `prop-sort-${p.id}`, label: `prop-label-${p.id}`, type: `type-${p.id}`, name: `name-${p.id}`, delete: `delete-prop-${p.id}` },
              values: { sort: String(p.sort), label: htmlDecode(p.label), type: p.type, name: p.name },
              locked: { type: !!(flags & DynamicFormField.MASK_CHANGE), name: !!(flags & DynamicFormField.MASK_NAME), delete: !!(flags & DynamicFormField.MASK_DELETE) },
            };
          })}
          newNames={{ sort: "prop-sort-new-{i}", label: "prop-label-new-{i}", type: "type-new-{i}", name: "name-new-{i}" }}
          newDefaults={{ type: "text" }}
          addLabel={t("addProperty")}
          removeLabel={f("remove")}
          emptyLabel={t("noProperties")}
        />
      </Section>
    </>
  );
}
