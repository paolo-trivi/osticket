import { getTranslations, setRequestLocale } from "next-intl/server";

import DataTable, { PageHeader } from "@/components/common/DataTable";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { listCanned } from "@/server/domain/kb/kb";
import { GlobalPerm } from "@/server/domain/staff/staff";
import { agentTimeZone, formatDbDate } from "@/server/format/datetime";

import { requireAgent } from "../../guard";

export async function generateMetadata() {
  return { title: (await getTranslations("canned"))("title") };
}

export default async function CannedPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const t = await getTranslations("canned");
  // chi gestisce le risposte (canned.manage) vede anche quelle disattivate
  const manage = agent.hasPermInAnyRole(GlobalPerm.CANNED_MANAGE);
  const rows = await listCanned(agent, { all: manage });
  const tz = await agentTimeZone(agent);
  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <DataTable
        empty={t("empty")}
        columns={[
          { key: "title", label: t("name") },
          { key: "dept", label: t("department") },
          { key: "status", label: t("status") },
          { key: "updated", label: t("updated") },
        ]}
        rows={rows.map((c) => ({
          key: c.canned_id,
          cells: {
            title: (
              <Link href={`/agent/canned/${c.canned_id}`} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
                {c.title}
              </Link>
            ),
            dept: c.dept_id ? c.dept : t("allDepts"),
            status: <Badge color={c.isenabled ? "success" : "light"} size="sm">{c.isenabled ? t("enabled") : t("disabled")}</Badge>,
            updated: formatDbDate(c.updated, tz, locale, "date"),
          },
        }))}
      />
    </div>
  );
}
