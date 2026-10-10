import { getTranslations, setRequestLocale } from "next-intl/server";

import ComponentCard from "@/components/common/ComponentCard";
import { PageHeader } from "@/components/common/DataTable";
import CategoryCard from "@/components/kb/CategoryCard";
import FaqList from "@/components/kb/FaqList";
import KbSearchForm from "@/components/kb/KbSearchForm";
import SubcategoryList from "@/components/kb/SubcategoryList";
import { redirect } from "@/i18n/navigation";
import { listTopCategories } from "@/server/domain/kb/categories";
import { kbSearchFilters, searchFaqs } from "@/server/domain/kb/search";

import { requireAgent } from "../../guard";

export async function generateMetadata() {
  return { title: (await getTranslations("kb"))("title") };
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const positiveInt = (v: string) => (/^\d+$/.test(v) ? Number(v) : 0);

/** scp/kb.php: elenco delle categorie o ricerca FAQ (q, cid, topicId). */
export default async function KbPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const sp = await searchParams;
  const q = one(sp.q).trim();
  const categoryId = positiveInt(one(sp.cid));
  const topicId = positiveInt(one(sp.topicId));
  const searching = !!q || !!topicId || (!!categoryId && one(sp.a) === "search");
  // kb.php?cid=N senza ricerca mostra la categoria (faq-category.inc.php): vecchi link compresi
  if (categoryId && !searching) redirect({ href: `/agent/kb/category/${categoryId}`, locale });

  const [t, tk] = await Promise.all([getTranslations("kb"), getTranslations("kbAgent")]);
  const vis = { featured: t("featured"), public: t("public"), internal: t("internal") };
  const [filters, results, categories] = await Promise.all([
    kbSearchFilters(agent),
    searching ? searchFaqs(agent, { q, categoryId, topicId }) : Promise.resolve(null),
    searching ? Promise.resolve(null) : listTopCategories(),
  ]);
  const countLabel = (n: number) => tk("faqTotal", { n });

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={searching ? undefined : tk("intro")} />
      <KbSearchForm
        q={q}
        categoryId={categoryId}
        topicId={topicId}
        active={searching}
        categories={filters.categories.map((c) => ({ id: c.id, label: tk("optionCount", { name: c.name, n: c.faqCount }) }))}
        topics={filters.topics.map((c) => ({ id: c.id, label: tk("optionCount", { name: c.name, n: c.faqCount }) }))}
        labels={{
          search: t("search"),
          searchButton: tk("searchButton"),
          reset: tk("reset"),
          category: tk("category"),
          topic: tk("topic"),
          allCategories: tk("optionCount", { name: tk("allCategories"), n: filters.total }),
          allTopics: tk("optionCount", { name: tk("allTopics"), n: filters.total }),
        }}
      />
      {results && (
        <ComponentCard title={q ? t("results", { q }) : tk("searchResults")}>
          <FaqList
            faqs={results}
            empty={tk("noResults")}
            labels={vis}
            attachmentsLabel={(n) => tk("attachmentCount", { n })}
          />
        </ComponentCard>
      )}
      {categories && categories.length === 0 && <p className="text-sm text-gray-500 dark:text-gray-400">{tk("noCategories")}</p>}
      {categories && categories.length > 0 && (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
          {categories.map((c) => (
            <CategoryCard
              key={c.id}
              id={c.id}
              name={c.name}
              visibility={c.visibility}
              countLabel={countLabel(c.faqCount)}
              descriptionHtml={c.descriptionHtml}
              labels={vis}
            >
              {c.children.length > 0 && <SubcategoryList items={c.children} labels={vis} countLabel={countLabel} />}
            </CategoryCard>
          ))}
        </div>
      )}
    </div>
  );
}
