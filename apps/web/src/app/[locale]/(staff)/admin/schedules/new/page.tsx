import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import AdminForm from "@/components/admin/AdminForm";
import { PageHeader } from "@/components/common/DataTable";
import { scheduleOptions, timezoneOptions } from "@/server/domain/admin/lookups";

import { requireAdmin } from "../../guard";
import { addScheduleAction } from "../actions";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("schedules");

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
      <PageHeader title={t("new")} actions={<BackLink href="/admin/schedules" label={t("back")} />} />
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
