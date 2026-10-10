"use client";

import ComponentCard from "@/components/common/ComponentCard";
import type { ThemeSettings } from "@/lib/theme/schema";
import { useTranslations } from "next-intl";

import { Field, Segmented, type SetThemeField } from "./controls";

interface AppearanceCardProps {
  settings: ThemeSettings;
  set: SetThemeField;
  /** anteprima immediata della modalità chiaro/scuro scelta */
  onPreviewMode: (mode: ThemeSettings["mode_default"]) => void;
}

/** Aspetto: modalità chiaro/scuro, barra laterale, carattere, arrotondamento e densità. */
export default function AppearanceCard({ settings, set, onPreviewMode }: AppearanceCardProps) {
  const t = useTranslations("admin.theme");
  return (
    <ComponentCard title={t("appearance")}>
      <Field label={t("modeDefault")}>
        <Segmented
          label={t("modeDefault")}
          value={settings.mode_default}
          onChange={(v) => {
            set("mode_default", v);
            onPreviewMode(v);
          }}
          options={[
            { value: "light", label: t("modes.light") },
            { value: "dark", label: t("modes.dark") },
            { value: "auto", label: t("modes.auto") },
          ]}
        />
      </Field>
      <label className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
        <input
          type="checkbox"
          checked={settings.allow_user_mode}
          onChange={(e) => set("allow_user_mode", e.target.checked)}
          className="size-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500"
        />
        {t("allowUserMode")}
      </label>
      <Field label={t("sidebar")}>
        <Segmented
          label={t("sidebar")}
          value={settings.sidebar_style}
          onChange={(v) => set("sidebar_style", v)}
          options={[
            { value: "light", label: t("sidebars.light") },
            { value: "dark", label: t("sidebars.dark") },
            { value: "brand", label: t("sidebars.brand") },
          ]}
        />
      </Field>
      <Field label={t("font")}>
        <Segmented
          label={t("font")}
          value={settings.font}
          onChange={(v) => set("font", v)}
          options={[
            { value: "outfit", label: "Outfit" },
            { value: "inter", label: "Inter" },
            { value: "system", label: t("fonts.system") },
          ]}
        />
      </Field>
      <Field label={t("radius")}>
        <Segmented
          label={t("radius")}
          value={settings.radius}
          onChange={(v) => set("radius", v)}
          options={(["none", "sm", "md", "lg", "xl"] as const).map((r) => ({ value: r, label: t(`radii.${r}`) }))}
        />
      </Field>
      <Field label={t("density")}>
        <Segmented
          label={t("density")}
          value={settings.density}
          onChange={(v) => set("density", v)}
          options={[
            { value: "comfortable", label: t("densities.comfortable") },
            { value: "compact", label: t("densities.compact") },
          ]}
        />
      </Field>
    </ComponentCard>
  );
}
