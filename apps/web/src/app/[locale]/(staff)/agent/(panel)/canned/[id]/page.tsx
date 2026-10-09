import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import ComponentCard from "@/components/common/ComponentCard";
import { PageHeader } from "@/components/common/DataTable";
import { Link } from "@/i18n/navigation";
import { loadCanned } from "@/server/domain/kb/kb";
import { safeHtml } from "@/server/format/sanitize";

import { requireAgent } from "../../../guard";

export default async function CannedViewPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const t = await getTranslations("canned");
  const c = await loadCanned(Number(id));
  if (!c || (c.dept_id && !agent.deptIds.includes(c.dept_id))) notFound();
  return (
    <div className="space-y-6">
      <Link href="/agent/canned" className="text-theme-sm text-gray-500 hover:text-brand-500">
        ← {t("title")}
      </Link>
      <PageHeader title={c.title} subtitle={c.dept_id ? c.dept : t("allDepts")} />
      <ComponentCard title={t("response")}>
        <div className="thread-body text-gray-700 dark:text-gray-300" dangerouslySetInnerHTML={{ __html: safeHtml(c.response, { decode: false }) }} />
      </ComponentCard>
    </div>
  );
}
