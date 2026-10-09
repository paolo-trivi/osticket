import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import ComponentCard from "@/components/common/ComponentCard";
import { PageHeader } from "@/components/common/DataTable";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { loadFaq } from "@/server/domain/kb/kb";
import { safeHtml } from "@/server/format/sanitize";

import { requireAgent } from "../../../../guard";

export default async function FaqPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireAgent(locale);
  const t = await getTranslations("kb");
  const faq = await loadFaq(Number(id));
  if (!faq) notFound();
  return (
    <div className="space-y-6">
      <Link href={`/agent/kb?cid=${faq.category_id}`} className="text-theme-sm text-gray-500 hover:text-brand-500">
        ← {faq.category}
      </Link>
      <PageHeader title={faq.question} />
      <div className="flex flex-wrap gap-2">
        <Badge color={faq.ispublished ? "success" : "light"}>{faq.ispublished === 2 ? t("featured") : faq.ispublished ? t("public") : t("internal")}</Badge>
        {faq.topics.map((tp) => (
          <Badge key={tp.topic_id} color="info">
            {tp.topic}
          </Badge>
        ))}
      </div>
      <ComponentCard title={t("answer")}>
        <div className="thread-body text-gray-700 dark:text-gray-300" dangerouslySetInnerHTML={{ __html: safeHtml(faq.answer, { decode: false }) }} />
      </ComponentCard>
      {faq.notes && (
        <ComponentCard title={t("notes")}>
          <div className="thread-body text-sm text-gray-600 dark:text-gray-400" dangerouslySetInnerHTML={{ __html: safeHtml(faq.notes, { decode: false }) }} />
        </ComponentCard>
      )}
    </div>
  );
}
