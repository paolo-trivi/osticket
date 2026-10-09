import { getTranslations, setRequestLocale } from "next-intl/server";

import KbSidebar from "@/components/portal/KbSidebar";
import { Link, redirect } from "@/i18n/navigation";
import { publicCategory } from "@/server/domain/client/kb";
import { safeHtml } from "@/server/format/sanitize";

import { requireKb } from "../../guard";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cat = await publicCategory(Number(id) || 0);
  return { title: cat?.name ?? (await getTranslations("portal.kb"))("title") };
}

/** kb/faq.php?cid=<id> (faq-category.inc.php): categoria pubblica, sottocategorie e FAQ. */
export default async function KbCategoryPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireKb(locale);
  const cat = await publicCategory(Number(id) || 0);
  if (!cat) redirect({ href: "/kb", locale });
  const c = cat!;
  const t = await getTranslations("portal.kb");
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <nav className="text-theme-sm text-gray-500 dark:text-gray-400">
          <Link href="/kb" className="hover:underline">
            {t("all")}
          </Link>
          {c.parent && (
            <>
              {" › "}
              <Link href={`/kb/category/${c.parent.id}`} className="hover:underline">
                {c.parent.name}
              </Link>
            </>
          )}
        </nav>
        <h1 className="text-title-sm font-semibold text-gray-800 dark:text-white/90">{c.name}</h1>
        {c.description && <div className="text-theme-sm text-gray-600 dark:text-gray-300" dangerouslySetInnerHTML={{ __html: safeHtml(c.description) }} />}
        {c.subcategories.length > 0 && (
          <ul className="space-y-1">
            {c.subcategories.map((s) => (
              <li key={s.id}>
                <Link href={`/kb/category/${s.id}`} className="text-brand-600 hover:underline dark:text-brand-400">
                  📁 {s.name} ({s.count})
                </Link>
              </li>
            ))}
          </ul>
        )}
        {c.faqs.length ? (
          <section className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-white/3">
            <h2 className="mb-3 font-medium text-gray-800 dark:text-white/90">{t("faqs")}</h2>
            <ol className="list-decimal space-y-2 ps-6">
              {c.faqs.map((f) => (
                <li key={f.id}>
                  <Link href={`/kb/faq/${f.id}`} className="text-brand-600 hover:underline dark:text-brand-400">
                    {f.question}
                  </Link>
                  {f.attachments ? <span className="ms-1 text-gray-400">📎</span> : null}
                </li>
              ))}
            </ol>
          </section>
        ) : (
          !c.subcategories.length && <p className="text-gray-500 dark:text-gray-400">{t("emptyCategory")}</p>
        )}
      </div>
      <KbSidebar topics={c.topics} />
    </div>
  );
}
