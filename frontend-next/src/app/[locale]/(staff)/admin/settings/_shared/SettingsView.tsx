import { getTranslations } from "next-intl/server";

import AdminForm from "@/components/admin/AdminForm";
import { PageHeader } from "@/components/common/DataTable";
import type { SettingsPage } from "@/server/domain/admin/settings";

import { saveSettingsAction } from "./actions";
import { settingsSections } from "./sections";

/** Pagina di impostazioni (scp/settings.php?t=<pagina>): titolo, form e salvataggio. */
export default async function SettingsView({ page, slug }: { page: SettingsPage; slug: string }) {
  const t = await getTranslations("admSettings");
  const sections = await settingsSections(page);
  return (
    <div className="space-y-6">
      <PageHeader title={t(`titles.${slug}`)} subtitle={t(`subtitles.${slug}`)} />
      <AdminForm sections={sections} action={saveSettingsAction.bind(null, page)} savedMessage={t("saved")} />
    </div>
  );
}
