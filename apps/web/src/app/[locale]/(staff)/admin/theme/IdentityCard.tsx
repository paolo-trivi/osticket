"use client";

import ComponentCard from "@/components/common/ComponentCard";
import Input from "@/components/form/input/InputField";
import Badge from "@/components/ui/badge/Badge";
import type { ThemeSettings } from "@/lib/theme/schema";
import { useTranslations } from "next-intl";

import { Field, type SetThemeField } from "./controls";

export interface LogoStatus {
  hasStaffLogo: boolean;
  hasClientLogo: boolean;
  hasBackdrop: boolean;
  /** pagina dei loghi nell'osTicket PHP */
  legacyLogoUrl?: string;
}

interface IdentityCardProps extends LogoStatus {
  settings: ThemeSettings;
  set: SetThemeField;
  helpdeskTitle: string;
}

/** Identità: nome dell'app, frase della pagina di accesso e loghi (caricati nell'osTicket PHP). */
export default function IdentityCard({ settings, set, helpdeskTitle, hasStaffLogo, hasClientLogo, hasBackdrop, legacyLogoUrl }: IdentityCardProps) {
  const t = useTranslations("admin.theme");
  return (
    <ComponentCard title={t("identity")}>
      <Field label={t("appName")} hint={t("appNameHint", { title: helpdeskTitle })} htmlFor="theme-app-name">
        <Input
          id="theme-app-name"
          aria-describedby="theme-app-name-hint"
          value={settings.app_name}
          maxLength={80}
          onChange={(e) => set("app_name", e.target.value)}
          placeholder={helpdeskTitle}
        />
      </Field>
      <Field label={t("tagline")} htmlFor="theme-tagline">
        <Input id="theme-tagline" value={settings.login_tagline} maxLength={200} onChange={(e) => set("login_tagline", e.target.value)} />
      </Field>
      <label className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
        <input
          type="checkbox"
          checked={settings.use_osticket_logos}
          onChange={(e) => set("use_osticket_logos", e.target.checked)}
          className="size-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500"
        />
        {t("useOsticketLogos")}
      </label>
      <div className="flex flex-wrap gap-2">
        <Badge color={hasStaffLogo ? "success" : "light"}>{t("logos.staff")}: {hasStaffLogo ? t("logos.custom") : t("logos.default")}</Badge>
        <Badge color={hasClientLogo ? "success" : "light"}>{t("logos.client")}: {hasClientLogo ? t("logos.custom") : t("logos.default")}</Badge>
        <Badge color={hasBackdrop ? "success" : "light"}>{t("logos.backdrop")}: {hasBackdrop ? t("logos.custom") : t("logos.default")}</Badge>
      </div>
      <p className="text-theme-xs text-gray-500 dark:text-gray-400">
        {t("logosHint")}{" "}
        {legacyLogoUrl && (
          <a href={legacyLogoUrl} className="text-brand-500 hover:text-brand-600" target="_blank" rel="noreferrer">
            {t("openLegacy")}
          </a>
        )}
      </p>
    </ComponentCard>
  );
}
