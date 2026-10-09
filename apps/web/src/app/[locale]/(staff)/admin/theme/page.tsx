import { getTranslations, setRequestLocale } from "next-intl/server";

import { loadTheme } from "@/server/theme/theme";

import { requireAdmin } from "../guard";
import ThemeEditor from "./ThemeEditor";

export default async function AdminThemePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admin.theme");
  const theme = await loadTheme();
  const { displayName, staffLogoId, clientLogoId, backdropId, ...settings } = theme;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-white/90">{t("title")}</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("desc")}</p>
      </div>
      <ThemeEditor
        initial={settings}
        helpdeskTitle={displayName}
        hasStaffLogo={staffLogoId > 0}
        hasClientLogo={clientLogoId > 0}
        hasBackdrop={backdropId > 0}
        legacyLogoUrl={process.env.OST_PHP_URL ? `${process.env.OST_PHP_URL}/scp/settings.php?t=pages` : undefined}
      />
    </div>
  );
}
