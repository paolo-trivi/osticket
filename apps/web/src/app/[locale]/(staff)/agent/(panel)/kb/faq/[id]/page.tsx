import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import ComponentCard from "@/components/common/ComponentCard";
import InfoRow from "@/components/common/InfoRow";
import AttachmentList from "@/components/kb/AttachmentList";
import HtmlContent from "@/components/kb/HtmlContent";
import KbBreadcrumb from "@/components/kb/KbBreadcrumb";
import VisibilityBadge from "@/components/kb/VisibilityBadge";
import Badge from "@/components/ui/badge/Badge";
import { idOrNotFound } from "@/lib/route-id";
import { agentFileUrl } from "@/server/domain/kb/html";
import { getFaq } from "@/server/domain/kb/faq";
import { agentTimeZone, formatDbDate, isoOf } from "@/server/format/datetime";

import { requireAgent } from "../../../../guard";

export async function generateMetadata() {
  return { title: (await getTranslations("kb"))("title") };
}

/** faq.php?id=N (faq-view.inc.php) in sola lettura. */
export default async function FaqPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const faq = await getFaq(agent, idOrNotFound(id));
  if (!faq) notFound();
  const [t, tk, tz] = await Promise.all([getTranslations("kb"), getTranslations("kbAgent"), agentTimeZone(agent)]);
  const vis = { featured: t("featured"), public: t("public"), internal: t("internal") };

  return (
    <div className="space-y-6">
      <KbBreadcrumb
        label={tk("breadcrumb")}
        items={[{ label: tk("allCategories"), href: "/agent/kb" }, ...faq.path.map((c) => ({ label: c.name, href: `/agent/kb/category/${c.id}` }))]}
      />
      <div className="space-y-2">
        <h2 className="text-xl font-semibold break-words text-gray-800 dark:text-white/90">{faq.question}</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          <time dateTime={isoOf(faq.updated)} title={formatDbDate(faq.updated, tz, locale)}>
            {tk("lastUpdated", { date: formatDbDate(faq.updated, tz, locale, "human") })}
          </time>
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <ComponentCard title={t("answer")}>
            <HtmlContent html={faq.answerHtml} />
          </ComponentCard>
          {faq.notesHtml && (
            <ComponentCard title={tk("notes")}>
              <HtmlContent html={faq.notesHtml} className="text-sm" />
            </ComponentCard>
          )}
        </div>
        <aside className="min-w-0 space-y-6">
          {faq.attachments.length > 0 && (
            <ComponentCard title={tk("attachments")}>
              <AttachmentList
                items={faq.attachments.map((a) => ({ id: a.id, name: a.name, size: a.size, href: agentFileUrl(a.key) }))}
                downloadLabel={(name) => tk("download", { name })}
              />
            </ComponentCard>
          )}
          <ComponentCard title={tk("visibility")}>
            <div className="flex flex-wrap items-center gap-2">
              <VisibilityBadge visibility={faq.visibility} labels={vis} size="md" />
              <Badge color={faq.isPublished ? "success" : "light"} size="sm">
                {faq.isPublished ? tk("published") : tk("notPublished")}
              </Badge>
            </div>
            <dl className="divide-y divide-gray-100 dark:divide-gray-800">
              <InfoRow label={tk("category")} value={<VisibilityBadge visibility={faq.category.visibility} labels={vis} />} />
              <InfoRow label={tk("created")} value={formatDbDate(faq.created, tz, locale)} />
              <InfoRow label={tk("updated")} value={formatDbDate(faq.updated, tz, locale)} />
            </dl>
          </ComponentCard>
          {faq.topics.length > 0 && (
            <ComponentCard title={tk("helpTopics")}>
              <ul className="space-y-1.5">
                {faq.topics.map((tp) => (
                  <li key={tp.id} className="text-sm break-words text-gray-700 dark:text-gray-300">
                    {tp.name}
                  </li>
                ))}
              </ul>
            </ComponentCard>
          )}
          {faq.keywords.length > 0 && (
            <ComponentCard title={tk("keywords")}>
              <div className="flex flex-wrap gap-2">
                {faq.keywords.map((k) => (
                  <Badge key={k} color="light" size="sm">
                    {k}
                  </Badge>
                ))}
              </div>
            </ComponentCard>
          )}
        </aside>
      </div>
    </div>
  );
}
