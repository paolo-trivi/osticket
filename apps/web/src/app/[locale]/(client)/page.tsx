import { getTranslations, setRequestLocale } from "next-intl/server";

import { RICH_CLASS } from "@/components/portal/rich";
import { Link } from "@/i18n/navigation";
import { withBase } from "@/lib/base-path";
import { coreConfig } from "@/server/config/config";
import { contentPage, featuredCategories, kbEnabled } from "@/server/domain/client/kb";
import { safeHtml } from "@/server/format/sanitize";

import { portalVisitor } from "./guard";

export async function generateMetadata() {
  const t = await getTranslations("portal.home");
  return { title: t("title") };
}

/**
 * Home del portale clienti (index.php): ricerca nella knowledge base, pagina "landing" configurata
 * (landing_page_id) o messaggio di benvenuto, scorciatoie e articoli in evidenza.
 */
export default async function PortalHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("portal.home");
  const [cfg, client] = await Promise.all([coreConfig(), portalVisitor(locale)]);
  const kb = await kbEnabled(cfg, client);
  const landing = await contentPage(cfg.int("landing_page_id"));
  const featured = kb ? await featuredCategories() : [];
  const canOpen = cfg.str("client_registration") !== "disabled" || !cfg.bool("clients_only");

  return (
    <div className="space-y-8">
      {kb && (
        <form action={withBase("/kb")} method="get" className="flex flex-col gap-3 sm:flex-row" role="search">
          <input
            name="q"
            placeholder={t("kbSearch")}
            aria-label={t("kbSearch")}
            className="h-11 flex-1 rounded-lg border border-gray-300 bg-white px-4 text-sm shadow-theme-xs focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90"
          />
          <button type="submit" className="h-11 rounded-lg bg-brand-500 px-6 text-sm font-medium text-white shadow-theme-xs hover:bg-brand-600">
            {t("search")}
          </button>
        </form>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="rounded-2xl border border-gray-200 bg-white p-6 lg:col-span-2 dark:border-gray-800 dark:bg-white/3">
          {landing ? (
            <div className={RICH_CLASS} dangerouslySetInnerHTML={{ __html: safeHtml(landing.body) }} />
          ) : (
            <h1 className="text-title-sm font-semibold text-gray-800 dark:text-white/90">{t("welcome")}</h1>
          )}
        </section>
        <aside className="space-y-3">
          {canOpen && (
            <Link href="/open" className="block rounded-2xl border border-brand-200 bg-brand-25 p-5 hover:bg-brand-50 dark:border-brand-800 dark:bg-brand-500/10">
              <span className="block text-base font-semibold text-brand-700 dark:text-brand-300">{t("openTitle")}</span>
              <span className="mt-1 block text-theme-sm text-gray-600 dark:text-gray-400">{t("openText")}</span>
            </Link>
          )}
          <Link
            href={client ? (client.guest ? `/tickets/${client.guest.ticketId}` : "/tickets") : "/login#access"}
            className="block rounded-2xl border border-gray-200 bg-white p-5 hover:bg-gray-50 dark:border-gray-800 dark:bg-white/3 dark:hover:bg-white/5"
          >
            <span className="block text-base font-semibold text-gray-800 dark:text-white/90">{client ? t("ticketsTitle") : t("statusTitle")}</span>
            <span className="mt-1 block text-theme-sm text-gray-600 dark:text-gray-400">{client ? t("ticketsText") : t("statusText")}</span>
          </Link>
        </aside>
      </div>

      {featured.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-white/90">{t("featured")}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {featured.map((c) => (
              <div key={c.id} className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-white/3">
                <h3 className="font-medium text-gray-800 dark:text-white/90">{c.name}</h3>
                <ul className="mt-3 space-y-3">
                  {c.faqs.map((f) => (
                    <li key={f.id}>
                      <Link href={`/kb/faq/${f.id}`} className="text-theme-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
                        {f.question}
                      </Link>
                      {f.teaser && <p className="text-theme-xs text-gray-500 dark:text-gray-400">{f.teaser}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
