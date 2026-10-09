import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import CannedFormatSwitch from "@/components/canned/CannedFormatSwitch";
import ComponentCard from "@/components/common/ComponentCard";
import InfoRow from "@/components/common/InfoRow";
import AttachmentList from "@/components/kb/AttachmentList";
import HtmlContent from "@/components/kb/HtmlContent";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { ChevronLeftIcon } from "@/icons";
import { agentFileUrl } from "@/server/domain/kb/html";
import { getCanned } from "@/server/domain/kb/kb";
import { agentTimeZone, formatDbDate } from "@/server/format/datetime";

import { requireAgent } from "../../../guard";

export async function generateMetadata() {
  return { title: (await getTranslations("canned"))("title") };
}

/** canned.php?id=N (cannedresponse.inc.php) in sola lettura. */
export default async function CannedViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ format?: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const c = await getCanned(agent, /^\d+$/.test(id) ? Number(id) : 0);
  if (!c) notFound();
  const asText = (await searchParams).format === "text";
  const [t, tk, tf, tz] = await Promise.all([
    getTranslations("canned"),
    getTranslations("kbAgent.canned"),
    getTranslations("kbAgent"),
    agentTimeZone(agent),
  ]);

  return (
    <div className="space-y-6">
      <Link href="/agent/canned" className="inline-flex items-center gap-1 text-theme-sm text-gray-500 hover:text-brand-500 dark:text-gray-400 dark:hover:text-brand-400">
        <ChevronLeftIcon className="size-4 rtl:rotate-180" aria-hidden />
        {tk("back")}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="min-w-0 text-xl font-semibold break-words text-gray-800 dark:text-white/90">{c.title}</h2>
        <Badge color={c.isEnabled ? "success" : "light"} size="sm">
          {c.isEnabled ? t("enabled") : t("disabled")}
        </Badge>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <ComponentCard title={t("response")}>
            <CannedFormatSwitch
              label={tk("format")}
              options={[
                { key: "html", label: tk("html"), href: `/agent/canned/${c.id}`, active: !asText },
                { key: "text", label: tk("text"), href: `/agent/canned/${c.id}?format=text`, active: asText },
              ]}
            />
            {asText ? (
              <pre className="overflow-x-auto font-outfit text-sm break-words whitespace-pre-wrap text-gray-700 dark:text-gray-300">{c.responseText}</pre>
            ) : (
              <HtmlContent html={c.responseHtml} />
            )}
          </ComponentCard>
          {c.notesHtml && (
            <ComponentCard title={tk("notes")}>
              <HtmlContent html={c.notesHtml} className="text-sm" />
            </ComponentCard>
          )}
        </div>
        <aside className="min-w-0 space-y-6">
          <ComponentCard title={tk("details")}>
            <dl className="divide-y divide-gray-100 dark:divide-gray-800">
              <InfoRow label={t("status")} value={c.isEnabled ? t("enabled") : t("disabled")} />
              <InfoRow label={t("department")} value={c.deptId ? (c.dept ?? `#${c.deptId}`) : t("allDepts")} />
              <InfoRow label={tk("language")} value={c.lang} />
              <InfoRow label={tk("created")} value={formatDbDate(c.created, tz, locale)} />
              <InfoRow label={t("updated")} value={formatDbDate(c.updated, tz, locale)} />
            </dl>
          </ComponentCard>
          {c.attachments.length > 0 && (
            <ComponentCard title={tk("files")}>
              <AttachmentList
                items={c.attachments.map((a) => ({ id: a.id, name: a.name, size: a.size, href: agentFileUrl(a.key) }))}
                downloadLabel={(name) => tf("download", { name })}
              />
            </ComponentCard>
          )}
        </aside>
      </div>
    </div>
  );
}
