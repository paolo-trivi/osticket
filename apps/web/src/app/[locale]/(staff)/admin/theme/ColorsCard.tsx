"use client";

import ComponentCard from "@/components/common/ComponentCard";
import Input from "@/components/form/input/InputField";
import Alert from "@/components/ui/alert/Alert";
import { isHexColor, paletteFromHex, relativeLuminance, SHADES } from "@/lib/theme/palette";
import { COLOR_PRESETS } from "@/lib/theme/schema";
import { cn } from "@/utils";
import { useTranslations } from "next-intl";

import { Field } from "./controls";

interface ColorsCardProps {
  /** colore primario corrente */
  color: string;
  /** testo del campo esadecimale (può non essere ancora un colore valido) */
  hexDraft: string;
  /** scelta di un colore valido (preset o selettore) */
  onColor: (color: string) => void;
  /** digitazione nel campo esadecimale */
  onHexDraft: (value: string) => void;
}

/** Colore del marchio: preset, colore personalizzato e scala generata, con avviso di basso contrasto. */
export default function ColorsCard({ color, hexDraft, onColor, onHexDraft }: ColorsCardProps) {
  const t = useTranslations("admin.theme");
  const palette = paletteFromHex(color);
  const lowContrast = relativeLuminance(color) > 0.45;
  const invalid = !isHexColor(hexDraft);
  return (
    <ComponentCard title={t("colors")} desc={t("colorsDesc")}>
      <div className="flex flex-wrap gap-3">
        {COLOR_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={color === p.color}
            onClick={() => onColor(p.color)}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-3 py-2 text-theme-sm",
              color === p.color
                ? "border-brand-500 ring-3 ring-brand-500/20"
                : "border-gray-200 dark:border-gray-800",
            )}
          >
            <span className="size-5 rounded-full ring-1 ring-black/15 dark:ring-white/25" style={{ backgroundColor: p.color }} />
            <span className="text-gray-700 dark:text-gray-300">{t(`presets.${p.id}`)}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <Field label={t("customColor")} htmlFor="theme-color">
          <div className="flex items-center gap-3">
            <input
              id="theme-color"
              type="color"
              value={color}
              onChange={(e) => onColor(e.target.value)}
              className="h-11 w-14 cursor-pointer rounded-lg border border-gray-200 bg-transparent dark:border-gray-800"
            />
            <Input
              value={hexDraft}
              onChange={(e) => onHexDraft(e.target.value)}
              className="font-mono w-32"
              aria-label={t("hexLabel")}
              aria-invalid={invalid}
              aria-describedby={invalid ? "theme-hex-error" : undefined}
              error={invalid}
            />
          </div>
          {invalid && (
            <p id="theme-hex-error" className="mt-1.5 text-theme-xs text-error-500">
              {t("hexInvalid")}
            </p>
          )}
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
  );
}
