import { getTranslations, setRequestLocale } from "next-intl/server";

import ComponentCard from "@/components/common/ComponentCard";
import { PageHeader } from "@/components/common/DataTable";
import InfoRow from "@/components/common/InfoRow";
import { db } from "@/server/db";
import { systemInfo } from "@/server/domain/adminsys/system-info";

import { requireAdmin } from "../guard";

/** Informazioni di sistema (include/staff/system.inc.php): PHP sostituito da Node/Next. */
export default async function SystemPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("asys.system");
  const info = await systemInfo(db());
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <ComponentCard title={t("server")}>
          <dl>
          <InfoRow label={t("osticketVersion")} value={info.osticketVersion ?? "—"} />
          <InfoRow label={t("nextVersion")} value={info.nextVersion ?? "—"} />
          <InfoRow label={t("nodeVersion")} value={info.nodeVersion} />
          <InfoRow label={t("dbVersion")} value={info.dbVersion} />
          <InfoRow label={t("plugins")} value={String(info.plugins)} />
          </dl>
        </ComponentCard>
        <ComponentCard title={t("database")}>
          <dl>
          <InfoRow label={t("schema")} value={`${info.dbName} (${info.dbHost})`} />
          <InfoRow label={t("prefix")} value={info.tablePrefix} />
          <InfoRow label={t("signature")} value={info.schemaSignature || "—"} />
          <InfoRow label={t("space")} value={`${info.spaceUsedMiB.toFixed(2)} MiB`} />
          <InfoRow label={t("attachments")} value={`${info.attachmentsMiB.toFixed(2)} MiB`} />
          <InfoRow
            label={t("timezone")}
            value={info.configuredDbTimezone && info.configuredDbTimezone !== info.dbTimezone ? `${info.dbTimezone} (${t("interpreted", { tz: info.configuredDbTimezone })})` : info.dbTimezone}
          />
          </dl>
        </ComponentCard>
        <ComponentCard title={t("languages")}>
          <p className="text-sm text-gray-700 dark:text-gray-300">{info.languages.length ? info.languages.join(", ") : "en_US"}</p>
        </ComponentCard>
        <ComponentCard title={t("notesTitle")}>
          <p className="text-sm text-gray-600 dark:text-gray-400">{t("notes")}</p>
        </ComponentCard>
      </div>
    </div>
  );
}
