import { getTranslations, setRequestLocale } from "next-intl/server";

import ComponentCard from "@/components/common/ComponentCard";
import { Link } from "@/i18n/navigation";

import { requireAdmin } from "./guard";

export default async function AdminHomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admin");

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-800 dark:text-white/90">{t("home")}</h2>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
        <ComponentCard title={t("theme.title")} desc={t("theme.desc")}>
          <Link href="/admin/theme" className="text-sm font-medium text-brand-500 hover:text-brand-600">
            {t("open")} →
          </Link>
        </ComponentCard>
      </div>
    </div>
  );
}
