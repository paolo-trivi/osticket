import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import ComponentCard from "@/components/common/ComponentCard";
import FaqList from "@/components/kb/FaqList";
import HtmlContent from "@/components/kb/HtmlContent";
import KbBreadcrumb from "@/components/kb/KbBreadcrumb";
import SubcategoryList from "@/components/kb/SubcategoryList";
import VisibilityBadge from "@/components/kb/VisibilityBadge";
import { getCategory } from "@/server/domain/kb/kb";
import { agentTimeZone, formatDbDate, isoOf } from "@/server/format/datetime";

import { requireAgent } from "../../../../guard";

/** kb.php?cid=N (faq-category.inc.php) in sola lettura. */
export default async function KbCategoryPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const category = await getCategory(agent, /^\d+$/.test(id) ? Number(id) : 0);
  if (!category) notFound();
  const [t, tk, tz] = await Promise.all([getTranslations("kb"), getTranslations("kbAgent"), agentTimeZone(agent)]);
  const vis = { featured: t("featured"), public: t("public"), internal: t("internal") };

  return (
    <div className="space-y-6">
      <KbBreadcrumb
        label={tk("breadcrumb")}
        items={[
          { label: tk("allCategories"), href: "/agent/kb" },
          ...category.path.map((c) => ({ label: c.name, href: c.id === category.id ? undefined : `/agent/kb/category/${c.id}` })),
        ]}
      />
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="min-w-0 text-xl font-semibold break-words text-gray-800 dark:text-white/90">{category.fullName}</h2>
          <VisibilityBadge visibility={category.visibility} labels={vis} size="md" />
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          <time dateTime={isoOf(category.updated)}>{tk("lastUpdated", { date: formatDbDate(category.updated, tz, locale) })}</time>
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          {category.descriptionHtml && (
            <ComponentCard title={tk("description")}>
              <HtmlContent html={category.descriptionHtml} />
            </ComponentCard>
          )}
          <ComponentCard title={tk("faqs")}>
            <FaqList
              faqs={category.faqs.map((f) => ({ ...f, category: undefined }))}
              empty={tk("categoryEmpty")}
              labels={vis}
              attachmentsLabel={(n) => tk("attachmentCount", { n })}
            />
            {category.hiddenFaqs > 0 && <p className="text-theme-xs text-gray-500 dark:text-gray-400">{tk("hiddenByTopic", { n: category.hiddenFaqs })}</p>}
          </ComponentCard>
        </div>
        <div className="min-w-0 space-y-6">
          {category.children.length > 0 && (
            <ComponentCard title={tk("subcategories")}>
              <SubcategoryList items={category.children} labels={vis} countLabel={(n) => tk("faqTotal", { n })} />
            </ComponentCard>
          )}
          {category.notesHtml && (
            <ComponentCard title={tk("notes")}>
              <HtmlContent html={category.notesHtml} className="text-sm" />
            </ComponentCard>
          )}
        </div>
      </div>
    </div>
  );
}
