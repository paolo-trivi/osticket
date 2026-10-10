import { getTranslations, setRequestLocale } from "next-intl/server";

import DataTable, { PageHeader, type DataColumn } from "@/components/common/DataTable";
import ManageInClassic from "@/components/kb/ManageInClassic";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { Paperclip } from "lucide-react";
import { CANNED_SORTS, listCanned, type CannedSort } from "@/server/domain/kb/canned";
import { GlobalPerm } from "@/server/domain/staff/staff";
import { agentTimeZone, formatDbDate } from "@/server/format/datetime";

import { requireAgent } from "../../guard";

export async function generateMetadata() {
  return { title: (await getTranslations("canned"))("title") };
}

export default async function CannedPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ sort?: string; order?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const sp = await searchParams;
  const sort: CannedSort = (CANNED_SORTS as readonly string[]).includes(sp.sort ?? "") ? (sp.sort as CannedSort) : "title";
  const order = sp.order === "desc" ? "desc" : "asc";
  const [t, tk] = await Promise.all([getTranslations("canned"), getTranslations("kbAgent")]);
  // chi gestisce le risposte (canned.manage) vede anche quelle disattivate
  const manage = agent.hasPermInAnyRole(GlobalPerm.CANNED_MANAGE);
  const rows = await listCanned(agent, { all: manage, sort, order });
  const tz = await agentTimeZone(agent);
  const phpUrl = process.env.OST_PHP_URL?.replace(/\/$/, "");

  // cannedresponses.inc.php: ordinamento per colonna, clic ripetuto inverte il verso
  const column = (key: CannedSort, label: string): DataColumn => ({
    key,
    label,
    sortHref: `/agent/canned?sort=${key}&order=${sort === key && order === "asc" ? "desc" : "asc"}`,
    sorted: sort === key ? order : undefined,
  });

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      {manage && <ManageInClassic note={tk("manageNote")} linkLabel={tk("manageCanned")} href={phpUrl ? `${phpUrl}/scp/canned.php` : undefined} />}
      <DataTable
        empty={t("empty")}
        columns={[column("title", t("name")), column("dept", t("department")), column("status", t("status")), column("updated", t("updated"))]}
        rows={rows.map((c) => ({
          key: c.canned_id,
          cells: {
            title: (
              <span className="inline-flex items-center gap-2">
                <Link href={`/agent/canned/${c.canned_id}`} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
                  {c.title}
                </Link>
                {c.files > 0 && (
                  <span className="inline-flex items-center text-gray-400 dark:text-gray-500" title={tk("attachmentCount", { n: c.files })}>
                    <Paperclip className="size-4" aria-hidden />
                    <span className="sr-only">{tk("attachmentCount", { n: c.files })}</span>
                  </span>
                )}
              </span>
            ),
            dept: c.dept_id ? c.dept : t("allDepts"),
            status: (
              <Badge color={c.isenabled ? "success" : "light"} size="sm">
                {c.isenabled ? t("enabled") : t("disabled")}
              </Badge>
            ),
            updated: formatDbDate(c.updated, tz, locale, "date"),
          },
        }))}
      />
    </div>
  );
}
