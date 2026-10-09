import { getTranslations, setRequestLocale } from "next-intl/server";

import KbSidebar from "@/components/portal/KbSidebar";
import { RICH_CLASS } from "@/components/portal/rich";
import { Link, redirect } from "@/i18n/navigation";
import { withBase } from "@/lib/base-path";
import { currentClient } from "@/server/auth/client-auth";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { detectDbTimezone } from "@/server/db/time";
import { publicFaq, topicsWithFaqs } from "@/server/domain/client/kb";
import { formatDbDate } from "@/server/format/datetime";
import { safeHtml } from "@/server/format/sanitize";

import { requireKb } from "../../guard";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const faq = await publicFaq(Number(id) || 0);
  return { title: faq?.question ?? (await getTranslations("portal.kb"))("title") };
}

/** kb/faq.php?id=<id> (faq.inc.php): FAQ pubblicata con allegati e help topic. */
export default async function KbFaqPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireKb(locale);
  const faq = await publicFaq(Number(id) || 0);
  if (!faq) redirect({ href: "/kb", locale });
  const f = faq!;
  const t = await getTranslations("portal.kb");
  const [cfg, client] = await Promise.all([coreConfig(), currentClient(), detectDbTimezone(db())]);
  const tz = client?.account?.timezone || cfg.str("default_timezone") || "UTC";
  const answer = safeHtml(f.answer).replace(/src="cid:([A-Za-z0-9_-]+)"/g, (_, key: string) => `src="${withBase(`/api/portal/file/${key}`)}?disposition=inline"`);
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <article className="space-y-4 lg:col-span-2">
        <nav className="text-theme-sm text-gray-500 dark:text-gray-400">
          <Link href="/kb" className="hover:underline">
            {t("all")}
          </Link>
          {" › "}
          <Link href={`/kb/category/${f.category.id}`} className="hover:underline">
            {f.category.name}
          </Link>
        </nav>
        <h1 className="text-title-sm font-semibold text-gray-800 dark:text-white/90">{f.question}</h1>
        <p className="text-theme-xs text-gray-500 dark:text-gray-400">{t("updated", { date: formatDbDate(f.updated, tz, locale, "date") })}</p>
        <div className={`rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-white/3 ${RICH_CLASS}`} dangerouslySetInnerHTML={{ __html: answer }} />
        {f.attachments.length > 0 && (
          <section>
            <h2 className="mb-2 text-theme-sm font-medium text-gray-800 dark:text-white/90">{t("attachments")}</h2>
            <div className="flex flex-wrap gap-2">
              {f.attachments.map((a) => (
                <a key={a.id} href={withBase(`/api/portal/file/${a.key}`)} className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-theme-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
                  📎 {a.name}
                </a>
              ))}
            </div>
          </section>
        )}
        {f.topics.length > 0 && (
          <p className="text-theme-xs text-gray-500 dark:text-gray-400">
            {t("topics")}: {f.topics.join(", ")}
          </p>
        )}
      </article>
      <KbSidebar topics={await topicsWithFaqs(undefined, f.category.id)} />
    </div>
  );
}
