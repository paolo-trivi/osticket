import { Folder } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";

import KbSidebar from "@/components/portal/KbSidebar";
import { Link } from "@/i18n/navigation";
import { publicCategories, searchFaqs, topicsWithFaqs } from "@/server/domain/client/kb";
import { safeHtml } from "@/server/format/sanitize";

import { requireKb } from "./guard";

export async function generateMetadata() {
  const t = await getTranslations("portal.kb");
  return { title: t("title") };
}

/** kb/index.php e kb/faq.php?a=search (knowledgebase.inc.php): categorie oppure risultati della ricerca. */
export default async function KbPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ q?: string; cid?: string; topicId?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireKb(locale);
  const sp = await searchParams;
  const t = await getTranslations("portal.kb");
  const searching = !!(sp.q || sp.cid || sp.topicId);
  const [cats, topics] = await Promise.all([publicCategories(), topicsWithFaqs()]);
  const results = searching ? await searchFaqs({ q: sp.q, categoryId: Number(sp.cid) || undefined, topicId: Number(sp.topicId) || undefined }) : [];

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <h1 className="text-title-sm font-semibold text-gray-800 dark:text-white/90">{searching ? t("results") : t("title")}</h1>
        {searching ? (
          results.length ? (
            <>
              <p className="text-theme-sm text-gray-500 dark:text-gray-400">{t("matched", { count: results.length })}</p>
              <ol className="list-decimal space-y-2 ps-6">
                {results.map((f) => (
                  <li key={f.id}>
                    <Link href={`/kb/faq/${f.id}`} className="text-brand-600 hover:underline dark:text-brand-400">
                      {f.question}
                    </Link>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="text-gray-500 dark:text-gray-400">{t("noResults")}</p>
          )
        ) : cats.length ? (
          <ul className="space-y-4">
            {cats.map((c) => (
              <li key={c.id} className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-white/3">
                <h2 className="font-medium">
                  <Link href={`/kb/category/${c.id}`} className="text-gray-800 hover:underline dark:text-white/90">
                    {c.name} {c.count ? `(${c.count})` : ""}
                  </Link>
                </h2>
                {c.description && (
                  <div
                    className="mt-1 text-theme-sm text-gray-500 dark:text-gray-400"
                    dangerouslySetInnerHTML={{
                      __html: safeHtml(c.description),
                    }}
                  />
                )}
                {c.subcategories.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {c.subcategories.map((s) => (
                      <li key={s.id}>
                        <Link href={`/kb/category/${s.id}`} className="inline-flex items-center gap-1.5 text-theme-sm text-brand-600 hover:underline dark:text-brand-400">
                          <Folder className="size-4" /> {s.name} ({s.count})
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                <ul className="mt-3 space-y-1">
                  {c.faqs.map((f) => (
                    <li key={f.id}>
                      <Link href={`/kb/faq/${f.id}`} className="text-theme-sm text-brand-600 hover:underline dark:text-brand-400">
                        {f.question}
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-gray-500 dark:text-gray-400">{t("none")}</p>
        )}
      </div>
      <KbSidebar topics={topics} categories={cats.map((c) => ({ id: c.id, name: c.name }))} q={sp.q} />
    </div>
  );
}
