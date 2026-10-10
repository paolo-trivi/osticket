"use client";

import { useBranding } from "@/context/BrandingContext";
import { useTheme } from "@/context/ThemeContext";
import { FONT_CLASS } from "@/lib/fonts";
import { isHexColor } from "@/lib/theme/palette";
import { DEFAULT_THEME, themeCss, type ThemeSettings } from "@/lib/theme/schema";
import { useEffect, useState, useTransition } from "react";

import { saveThemeAction, type SaveThemeState } from "./actions";
import AppearanceCard from "./AppearanceCard";
import ColorsCard from "./ColorsCard";
import type { SetThemeField } from "./controls";
import IdentityCard, { type LogoStatus } from "./IdentityCard";
import PreviewCard from "./PreviewCard";
import SaveControls from "./SaveControls";

interface Props extends LogoStatus {
  initial: ThemeSettings;
  helpdeskTitle: string;
}

/** Applica il tema alla pagina corrente senza salvare (anteprima dal vivo). */
function applyPreview(settings: ThemeSettings) {
  const style = document.getElementById("ost-theme");
  if (style) style.textContent = themeCss(settings);
  const body = document.body;
  for (const cls of Object.values(FONT_CLASS)) for (const c of cls.split(" ")) body.classList.remove(c);
  for (const c of FONT_CLASS[settings.font].split(" ")) body.classList.add(c);
}

/**
 * Editor del tema: contenitore con le impostazioni in modifica, l'anteprima dal vivo e il salvataggio;
 * le sezioni (colori, aspetto, identità, anteprima, salvataggio) sono presentazionali.
 */
export default function ThemeEditor({ initial, helpdeskTitle, hasStaffLogo, hasClientLogo, hasBackdrop, legacyLogoUrl }: Props) {
  const branding = useBranding();
  const { setThemeMode } = useTheme();
  const [settings, setSettings] = useState<ThemeSettings>(initial);
  const [saved, setSaved] = useState<ThemeSettings>(initial);
  const [state, setState] = useState<SaveThemeState>({ status: "idle" });
  const [pending, startTransition] = useTransition();
  const [hexDraft, setHexDraft] = useState(initial.primary_color);

  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);
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

  const set: SetThemeField = (key, value) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setState({ status: "idle" });
  };

  const pickColor = (color: string) => {
    set("primary_color", color);
    setHexDraft(color);
  };
  const editHex = (value: string) => {
    setHexDraft(value);
    if (isHexColor(value)) set("primary_color", value.toLowerCase());
  };
  const restore = (next: ThemeSettings) => {
    setSettings(next);
    setHexDraft(next.primary_color);
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
        <ColorsCard color={settings.primary_color} hexDraft={hexDraft} onColor={pickColor} onHexDraft={editHex} />
        <AppearanceCard settings={settings} set={set} onPreviewMode={previewMode} />
        <IdentityCard
          settings={settings}
          set={set}
          helpdeskTitle={helpdeskTitle}
          hasStaffLogo={hasStaffLogo}
          hasClientLogo={hasClientLogo}
          hasBackdrop={hasBackdrop}
          legacyLogoUrl={legacyLogoUrl}
        />
      </div>

      <div className="space-y-6">
        <div className="sticky top-24 space-y-6">
          <PreviewCard />
          <SaveControls
            state={state}
            dirty={dirty}
            pending={pending}
            canSave={isHexColor(settings.primary_color)}
            onSave={save}
            onDiscard={() => restore(saved)}
            onReset={() => restore({ ...DEFAULT_THEME })}
          />
        </div>
      </div>
    </div>
  );
}
