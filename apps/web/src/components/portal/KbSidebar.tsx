import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";
import { withBase } from "@/lib/base-path";

/** Barra laterale della knowledge base: ricerca, help topic con FAQ, categorie. */
export default async function KbSidebar({ topics, categories, q }: { topics: { id: number; name: string }[]; categories?: { id: number; name: string }[]; q?: string }) {
  const t = await getTranslations("portal.kb");
  return (
    <aside className="space-y-5">
      <form action={withBase("/kb")} method="get" role="search">
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder={t("search")}
          aria-label={t("search")}
          className="h-11 w-full rounded-lg border border-gray-300 bg-white px-4 text-sm shadow-theme-xs dark:border-gray-700 dark:bg-gray-900 dark:text-white/90"
        />
      </form>
      {topics.length > 0 && (
        <section className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-white/3">
          <h2 className="mb-2 text-theme-sm font-medium text-gray-800 dark:text-white/90">{t("topics")}</h2>
          <ul className="space-y-1">
            {topics.map((tp) => (
              <li key={tp.id}>
                <Link href={`/kb?topicId=${tp.id}`} className="text-theme-sm text-brand-600 hover:underline dark:text-brand-400">
                  {tp.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {categories && categories.length > 0 && (
        <section className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-white/3">
          <h2 className="mb-2 text-theme-sm font-medium text-gray-800 dark:text-white/90">{t("categories")}</h2>
          <ul className="space-y-1">
            {categories.map((c) => (
              <li key={c.id}>
                <Link href={`/kb/category/${c.id}`} className="text-theme-sm text-brand-600 hover:underline dark:text-brand-400">
                  {c.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
