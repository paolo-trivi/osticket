import { Inter, Outfit } from "next/font/google";

import type { ThemeSettings } from "./theme/schema";

const outfit = Outfit({ subsets: ["latin"] });
const inter = Inter({ subsets: ["latin"] });

/** Classi dei font selezionabili nel tema (condivise da layout ed editor). */
export const FONT_CLASS: Record<ThemeSettings["font"], string> = {
  outfit: outfit.className,
  inter: inter.className,
  system: "font-sans",
};
