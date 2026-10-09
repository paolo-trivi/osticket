/**
 * Generazione della scala colori (25…950) a partire da un colore base, nello stesso formato
 * dei token Tailwind del tema (--color-brand-*). Il colore scelto diventa il 500.
 */
export const SHADES = ["25", "50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"] as const;
type Shade = (typeof SHADES)[number];

/** quanto mescolare con bianco (valori positivi) o nero (negativi) per ogni tonalità */
const MIX: Record<Shade, number> = {
  "25": 0.96,
  "50": 0.9,
  "100": 0.78,
  "200": 0.6,
  "300": 0.4,
  "400": 0.2,
  "500": 0,
  "600": -0.12,
  "700": -0.28,
  "800": -0.42,
  "900": -0.55,
  "950": -0.74,
};

export function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function toRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("");
}

export function paletteFromHex(hex: string): Record<Shade, string> {
  const base = toRgb(hex);
  const out = {} as Record<Shade, string>;
  for (const shade of SHADES) {
    const m = MIX[shade];
    const target = m >= 0 ? 255 : 0;
    const w = Math.abs(m);
    out[shade] = toHex(base.map((c) => c + (target - c) * w) as [number, number, number]);
  }
  return out;
}

/** Luminanza relativa WCAG: serve a scegliere testo bianco o scuro sui pulsanti primari. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
