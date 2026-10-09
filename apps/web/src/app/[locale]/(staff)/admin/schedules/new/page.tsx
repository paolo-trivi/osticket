import { getTranslations, setRequestLocale } from "next-intl/server";

import AdminForm from "@/components/admin/AdminForm";
import { PageHeader } from "@/components/common/DataTable";
import { Link } from "@/i18n/navigation";
import { scheduleOptions, timezoneOptions } from "@/server/domain/admin/lookups";

import { requireAdmin } from "../../guard";
import { addScheduleAction } from "../actions";

/** Nuovo orario o copia di uno esistente (ajax.schedule.php add/clone). */
export default async function NewSchedulePage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admSchedules");
  const sp = await searchParams;
  const schedules = await scheduleOptions();
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("new")}
        actions={
          <Link href="/admin/schedules" className="text-sm font-medium text-brand-500 hover:text-brand-600">
            ← {t("back")}
          </Link>
        }
      />
      <AdminForm
        action={addScheduleAction}
        submitLabel={t("create")}
        sections={[
          {
            title: t("sections.schedule"),
            fields: [
              { kind: "text", name: "name", label: t("name"), required: true },
              {
                kind: "select",
                name: "type",
                label: t("type"),
                value: "bizhrs",
                options: [
                  { value: "bizhrs", label: t("bizhrs") },
                  { value: "hdays", label: t("hdays") },
                ],
              },
              { kind: "select", name: "timezone", label: t("timezone"), value: "", options: [{ value: "", label: t("floating") }, ...timezoneOptions()] },
              { kind: "select", name: "clone", label: t("cloneFrom"), value: sp.clone ?? "", options: [{ value: "", label: t("noClone") }, ...schedules] },
              { kind: "textarea", name: "description", label: t("description"), rows: 3, wide: true },
            ],
          },
        ]}
      />
    </div>
  );
}
