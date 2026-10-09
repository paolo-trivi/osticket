import { describe, expect, it } from "vitest";

import { isHexColor, paletteFromHex, relativeLuminance } from "@/lib/theme/palette";
import { DEFAULT_THEME, ThemeSchema, themeCss } from "@/lib/theme/schema";

describe("palette del tema", () => {
  it("il colore scelto diventa il 500 e la scala va dal chiaro allo scuro", () => {
    const p = paletteFromHex("#f68d29");
    expect(p["500"]).toBe("#f68d29");
    expect(relativeLuminance(p["25"])).toBeGreaterThan(relativeLuminance(p["500"]));
    expect(relativeLuminance(p["950"])).toBeLessThan(relativeLuminance(p["500"]));
  });

  it("valida solo colori #rrggbb", () => {
    expect(isHexColor("#0e7490")).toBe(true);
    expect(isHexColor("red")).toBe(false);
    expect(isHexColor("#fff")).toBe(false);
  });

  it("genera i token CSS e ignora colori non validi", () => {
    const css = themeCss({ ...DEFAULT_THEME, primary_color: "#0e7490", density: "compact", radius: "none" });
    expect(css).toContain("--color-brand-500:#0e7490");
    expect(css).toContain("--radius-lg:0px");
    expect(css).toContain("font-size:15px");
    expect(themeCss({ ...DEFAULT_THEME, primary_color: "javascript:alert(1)" })).toContain("--color-brand-500:#f68d29");
  });

  it("lo schema rifiuta valori fuori elenco", () => {
    expect(ThemeSchema.safeParse({ ...DEFAULT_THEME, sidebar_style: "neon" }).success).toBe(false);
    expect(ThemeSchema.safeParse(DEFAULT_THEME).success).toBe(true);
  });
});
