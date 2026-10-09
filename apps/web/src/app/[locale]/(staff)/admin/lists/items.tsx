import "server-only";

import { getTranslations } from "next-intl/server";

import { Section, TextAreaField, TextField } from "@/components/adminsys/fields";
import { phpJsonDecode } from "@/server/format/php-json";

/** Campi dell'elemento: valore, abbreviazione e proprietà testuali (ajax.forms.php, list-item-properties). */
export async function ItemFields({
  item,
  properties,
}: {
  item: { value: string; extra: string | null; properties: string | null } | null;
  properties: { id: number; type: string; label: string; flags: number | null }[];
}) {
  const t = await getTranslations("asys.lists");
  const values = phpJsonDecode<Record<string, unknown>>(item?.properties, {});
  return (
    <Section title={item ? t("editItem") : t("addItem")}>
      <TextField name="value" label={t("value")} value={item?.value} required />
      <TextField name="extra" label={t("abbrev")} value={item?.extra} />
      {properties
        .filter((p) => p.type === "text" || p.type === "memo")
        .map((p) =>
          p.type === "memo" ? (
            <TextAreaField key={p.id} name={String(p.id)} label={p.label} value={String(values[p.id] ?? "")} rows={3} />
          ) : (
            <TextField key={p.id} name={String(p.id)} label={p.label} value={String(values[p.id] ?? "")} />
          ),
        )}
    </Section>
  );
}
