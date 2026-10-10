import { getTranslations, setRequestLocale } from "next-intl/server";

import { NewButton } from "@/components/adminsys/BackLink";
import SysNotice from "@/components/adminsys/SysNotice";
import MassBar from "@/components/admin/MassBar";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import { Link } from "@/i18n/navigation";
import { DynamicForm } from "@/lib/osticket/flags";
import { FormType } from "@/lib/osticket/object-types";
import { db } from "@/server/db";
import { listForms } from "@/server/domain/adminsys/form";

import { dateFormatter } from "../_sys/server";
import { requireAdmin } from "../guard";
import { massFormAction } from "./actions";

/** Form personalizzati (include/staff/dynamic-forms.inc.php): form di sistema e form "G". */
export default async function FormsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAdmin(locale);
  const t = await getTranslations("asys.forms");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  const date = await dateFormatter(agent, locale);
  const forms = await listForms(db());
  const table = (rows: typeof forms, mass: boolean) => (
    <DataTable
      empty={c("empty")}
      columns={[
        ...(mass ? [{ key: "sel", label: "", className: "w-10" }] : []),
        { key: "title", label: t("formTitle") },
        { key: "type", label: t("type") },
        { key: "fields", label: t("fieldsCount") },
        { key: "updated", label: c("updated") },
      ]}
      rows={rows.map((f) => ({
        key: f.id,
        cells: {
          sel: <input type="checkbox" name="ids[]" value={f.id} disabled={!(f.flags & DynamicForm.DELETABLE)} className="h-4 w-4 accent-brand-500" aria-label={f.title} />,
          title: (
            <Link href={`/admin/forms/${f.id}`} className="font-medium text-brand-500 hover:text-brand-600">
              {f.title}
            </Link>
          ),
          type: t.has(`types.${f.type}`) ? t(`types.${f.type}`) : f.type,
          fields: f.fields,
          updated: date(f.updated),
        },
      }))}
    />
  );
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} actions={<NewButton href="/admin/forms/new" label={t("new")} />} />
      <SysNotice sp={sp} />
      <h3 className="text-base font-semibold text-gray-800 dark:text-white/90">{t("builtIn")}</h3>
      {table(
        forms.filter((f) => f.type !== FormType.GENERIC),
        false,
      )}
      <h3 className="text-base font-semibold text-gray-800 dark:text-white/90">{t("custom")}</h3>
      <form action={massFormAction} className="space-y-4">
        <MassBar actions={[{ value: "delete", label: c("delete"), danger: true }]} />
        {table(
          forms.filter((f) => f.type === FormType.GENERIC),
          true,
        )}
      </form>
    </div>
  );
}
