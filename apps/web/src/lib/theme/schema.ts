import { z } from "zod";

import { isHexColor, paletteFromHex, SHADES } from "./palette";

/** Impostazioni del tema (condivise tra server ed editor nel browser). */
export const ThemeSchema = z.object({
  primary_color: z.string().refine(isHexColor),
  mode_default: z.enum(["light", "dark", "auto"]),
  allow_user_mode: z.boolean(),
  sidebar_style: z.enum(["light", "dark", "brand"]),
  font: z.enum(["outfit", "inter", "system"]),
  radius: z.enum(["none", "sm", "md", "lg", "xl"]),
  density: z.enum(["comfortable", "compact"]),
  app_name: z.string().max(80),
  login_tagline: z.string().max(200),
  use_osticket_logos: z.boolean(),
});
export type ThemeSettings = z.infer<typeof ThemeSchema>;

export const DEFAULT_THEME: ThemeSettings = {
  primary_color: "#465fff",
  mode_default: "light",
  allow_user_mode: true,
  sidebar_style: "light",
  font: "outfit",
  radius: "lg",
  density: "comfortable",
  app_name: "",
  login_tagline: "",
  use_osticket_logos: true,
};

/** Colori predefiniti proposti nell'editor. */
export const COLOR_PRESETS: { id: string; color: string }[] = [
  { id: "tailticket", color: "#465fff" },
  { id: "osticket", color: "#f68d29" },
  { id: "hospital", color: "#0e7490" },
  { id: "green", color: "#12b76a" },
  { id: "purple", color: "#7a5af8" },
  { id: "red", color: "#d92d20" },
  { id: "slate", color: "#475467" },
];

const RADIUS: Record<ThemeSettings["radius"], [string, string, string, string]> = {
  // --radius-md, --radius-lg, --radius-xl, --radius-2xl
  none: ["0px", "0px", "0px", "0px"],
  sm: ["0.25rem", "0.3rem", "0.4rem", "0.5rem"],
  md: ["0.35rem", "0.45rem", "0.6rem", "0.8rem"],
  lg: ["0.375rem", "0.5rem", "0.75rem", "1rem"],
  xl: ["0.5rem", "0.75rem", "1rem", "1.5rem"],
};

/** CSS che sovrascrive i token Tailwind del tema: colori brand, raggi, densità. */
export function themeCss(theme: ThemeSettings): string {
  const palette = paletteFromHex(isHexColor(theme.primary_color) ? theme.primary_color : DEFAULT_THEME.primary_color);
  const [md, lg, xl, xxl] = RADIUS[theme.radius] ?? RADIUS.lg;
  const vars = [
    ...SHADES.map((s) => `--color-brand-${s}:${palette[s]}`),
    `--radius-md:${md}`,
    `--radius-lg:${lg}`,
    `--radius-xl:${xl}`,
    `--radius-2xl:${xxl}`,
  ];
  let css = `html:root{${vars.join(";")}}`;
  if (theme.density === "compact") css += "html:root{font-size:15px}";
  return css;
}
