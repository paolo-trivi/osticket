"use client";

import ComponentCard from "@/components/common/ComponentCard";
import Label from "@/components/form/Label";
import Input from "@/components/form/input/InputField";
import Alert from "@/components/ui/alert/Alert";
import Badge from "@/components/ui/badge/Badge";
import Button from "@/components/ui/button/Button";
import { useBranding } from "@/context/BrandingContext";
import { useTheme } from "@/context/ThemeContext";
import { FONT_CLASS } from "@/lib/fonts";
import { isHexColor, paletteFromHex, relativeLuminance, SHADES } from "@/lib/theme/palette";
import { COLOR_PRESETS, DEFAULT_THEME, themeCss, type ThemeSettings } from "@/lib/theme/schema";
import { cn } from "@/utils";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition, type ReactNode } from "react";

import { saveThemeAction, type SaveThemeState } from "./actions";

interface Props {
  initial: ThemeSettings;
  helpdeskTitle: string;
  hasStaffLogo: boolean;
  hasClientLogo: boolean;
  hasBackdrop: boolean;
  legacyLogoUrl?: string;
}

/** Applica il tema alla pagina corrente senza salvare (anteprima dal vivo). */
function applyPreview(settings: ThemeSettings) {
  const style = document.getElementById("ost-theme");
  if (style) style.textContent = themeCss(settings);
  const body = document.body;
  for (const cls of Object.values(FONT_CLASS)) for (const c of cls.split(" ")) body.classList.remove(c);
  for (const c of FONT_CLASS[settings.font].split(" ")) body.classList.add(c);
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-900">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-3 py-1.5 text-theme-sm font-medium transition",
            value === o.value
              ? "bg-white text-gray-900 shadow-theme-xs dark:bg-gray-800 dark:text-white"
              : "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
      {hint && <p className="mt-1.5 text-theme-xs text-gray-500 dark:text-gray-400">{hint}</p>}
    </div>
  );
}

export default function ThemeEditor({ initial, helpdeskTitle, hasStaffLogo, hasClientLogo, hasBackdrop, legacyLogoUrl }: Props) {
  const t = useTranslations("admin.theme");
  const branding = useBranding();
  const { setThemeMode } = useTheme();
  const [settings, setSettings] = useState<ThemeSettings>(initial);
  const [saved, setSaved] = useState<ThemeSettings>(initial);
  const [state, setState] = useState<SaveThemeState>({ status: "idle" });
  const [pending, startTransition] = useTransition();
  const [hexDraft, setHexDraft] = useState(initial.primary_color);

  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);
  const palette = paletteFromHex(settings.primary_color);
  const lowContrast = relativeLuminance(settings.primary_color) > 0.45;
  const { preview } = branding;

  // Anteprima dal vivo; all'uscita dalla pagina si torna al tema salvato
  useEffect(() => {
    applyPreview(settings);
    preview({ sidebarStyle: settings.sidebar_style, displayName: settings.app_name || helpdeskTitle });
  }, [settings, helpdeskTitle, preview]);
  useEffect(
    () => () => {
      applyPreview(saved);
      preview(null);
    },
    [saved, preview],
  );

  // anteprima chiaro/scuro anche se agli utenti non è consentito sceglierla
  const previewMode = (mode: ThemeSettings["mode_default"]) => {
    setThemeMode(mode);
    const dark = mode === "dark" || (mode === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  };

  const set = <K extends keyof ThemeSettings>(key: K, value: ThemeSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setState({ status: "idle" });
  };

  const save = () =>
    startTransition(async () => {
      const result = await saveThemeAction(settings);
      setState(result);
      if (result.status === "saved") setSaved(settings);
    });

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <div className="space-y-6 xl:col-span-2">
        <ComponentCard title={t("colors")} desc={t("colorsDesc")}>
          <div className="flex flex-wrap gap-3">
            {COLOR_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  set("primary_color", p.color);
                  setHexDraft(p.color);
                }}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-theme-sm",
                  settings.primary_color === p.color
                    ? "border-brand-500 ring-3 ring-brand-500/20"
                    : "border-gray-200 dark:border-gray-800",
                )}
              >
                <span className="size-5 rounded-full" style={{ backgroundColor: p.color }} />
                <span className="text-gray-700 dark:text-gray-300">{t(`presets.${p.id}`)}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <Field label={t("customColor")}>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={settings.primary_color}
                  onChange={(e) => {
                    set("primary_color", e.target.value);
                    setHexDraft(e.target.value);
                  }}
                  className="h-11 w-14 cursor-pointer rounded-lg border border-gray-200 bg-transparent dark:border-gray-800"
                  aria-label={t("customColor")}
                />
                <Input
                  value={hexDraft}
                  onChange={(e) => {
                    setHexDraft(e.target.value);
                    if (isHexColor(e.target.value)) set("primary_color", e.target.value.toLowerCase());
                  }}
                  className="w-32 font-mono"
                  error={!isHexColor(hexDraft)}
                />
              </div>
            </Field>
          </div>
          <div className="flex overflow-hidden rounded-lg">
            {SHADES.map((s) => (
              <div key={s} className="flex-1 py-3 text-center text-[10px] font-medium" style={{ backgroundColor: palette[s], color: Number(s) >= 500 ? "#fff" : "#101828" }}>
                {s}
              </div>
            ))}
          </div>
          {lowContrast && <Alert variant="warning" title={t("lowContrast")} message="" />}
        </ComponentCard>

        <ComponentCard title={t("appearance")}>
          <Field label={t("modeDefault")}>
            <Segmented
              value={settings.mode_default}
              onChange={(v) => {
                set("mode_default", v);
                previewMode(v);
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
              value={settings.radius}
              onChange={(v) => set("radius", v)}
              options={(["none", "sm", "md", "lg", "xl"] as const).map((r) => ({ value: r, label: t(`radii.${r}`) }))}
            />
          </Field>
          <Field label={t("density")}>
            <Segmented
              value={settings.density}
              onChange={(v) => set("density", v)}
              options={[
                { value: "comfortable", label: t("densities.comfortable") },
                { value: "compact", label: t("densities.compact") },
              ]}
            />
          </Field>
        </ComponentCard>

        <ComponentCard title={t("identity")}>
          <Field label={t("appName")} hint={t("appNameHint", { title: helpdeskTitle })}>
            <Input value={settings.app_name} maxLength={80} onChange={(e) => set("app_name", e.target.value)} placeholder={helpdeskTitle} />
          </Field>
          <Field label={t("tagline")}>
            <Input value={settings.login_tagline} maxLength={200} onChange={(e) => set("login_tagline", e.target.value)} />
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
      </div>

      <div className="space-y-6">
        <div className="sticky top-24 space-y-6">
          <ComponentCard title={t("preview")}>
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button size="sm">{t("sample.primary")}</Button>
                <Button size="sm" variant="outline">
                  {t("sample.secondary")}
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge color="primary">{t("sample.badge")}</Badge>
                <Badge color="success">{t("sample.open")}</Badge>
                <Badge color="warning">{t("sample.overdue")}</Badge>
              </div>
              <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
                <p className="text-sm font-medium text-gray-800 dark:text-white/90">#247301 · {t("sample.subject")}</p>
                <p className="mt-1 text-theme-xs text-gray-500 dark:text-gray-400">{t("sample.meta")}</p>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                  <div className="h-full w-2/3 rounded-full bg-brand-500" />
                </div>
              </div>
            </div>
          </ComponentCard>

          <div className="space-y-3">
            {state.status === "saved" && <Alert variant="success" title={t("saved")} message="" />}
            {state.status === "error" && <Alert variant="error" title={t("error")} message={state.message ?? ""} />}
            <div className="flex gap-3">
              <Button onClick={save} disabled={!dirty || pending || !isHexColor(settings.primary_color)} className="flex-1">
                {pending ? t("saving") : t("save")}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setSettings(saved);
                  setHexDraft(saved.primary_color);
                }}
                disabled={!dirty || pending}
              >
                {t("discard")}
              </Button>
            </div>
            <button
              type="button"
              onClick={() => {
                setSettings({ ...DEFAULT_THEME });
                setHexDraft(DEFAULT_THEME.primary_color);
              }}
              className="text-theme-xs text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white"
            >
              {t("resetDefaults")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
