import { getTranslations, setRequestLocale } from "next-intl/server";

import ComponentCard from "@/components/common/ComponentCard";
import { PageHeader, SearchBox } from "@/components/common/DataTable";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { listCategories, listFaqs } from "@/server/domain/kb/kb";
import { safeHtml } from "@/server/format/sanitize";

import { requireAgent } from "../../guard";

export async function generateMetadata() {
  return { title: (await getTranslations("kb"))("title") };
}

export default async function KbPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string; cid?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAgent(locale);
  const t = await getTranslations("kb");
  const sp = await searchParams;
  const categoryId = Number(sp.cid) || undefined;
  const [categories, faqs] = await Promise.all([listCategories(), sp.q || categoryId ? listFaqs({ q: sp.q, categoryId }) : Promise.resolve([])]);
  const visibility = (p: number) => (p === 2 ? t("featured") : p === 1 ? t("public") : t("internal"));

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} actions={<SearchBox action="/agent/kb" value={sp.q} placeholder={t("search")} />} />
      {(sp.q || categoryId) && (
        <ComponentCard title={sp.q ? t("results", { q: sp.q }) : (categories.find((c) => c.category_id === categoryId)?.name ?? "")}>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {faqs.length === 0 && <li className="py-3 text-sm text-gray-500">{t("empty")}</li>}
            {faqs.map((f) => (
              <li key={f.faq_id} className="flex items-center justify-between gap-3 py-3">
                <Link href={`/agent/kb/faq/${f.faq_id}`} className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
                  {f.question}
                </Link>
                <Badge color={f.ispublished ? "success" : "light"} size="sm">
                  {visibility(f.ispublished)}
                </Badge>
              </li>
            ))}
          </ul>
        </ComponentCard>
      )}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
        {categories.map((c) => (
          <Link
            key={c.category_id}
            href={`/agent/kb?cid=${c.category_id}`}
            className="rounded-2xl border border-gray-200 bg-white p-5 hover:border-brand-300 dark:border-gray-800 dark:bg-white/3"
          >
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-medium text-gray-800 dark:text-white/90">{c.name}</h3>
              <Badge color={c.ispublic ? "success" : "light"} size="sm">
                {visibility(c.ispublic)}
              </Badge>
            </div>
            <p className="mt-2 line-clamp-2 text-sm text-gray-500 dark:text-gray-400" dangerouslySetInnerHTML={{ __html: safeHtml(c.description, { decode: false }) }} />
            <p className="mt-3 text-theme-xs text-gray-400">{t("faqCount", { n: c.faqs, published: c.published })}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
