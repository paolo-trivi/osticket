import { ItFlagIcon, UsFlagIcon } from "@/icons";

import type { Locale } from "./routing";

interface Language {
  id: Locale;
  name: string;
  shortName: string;
  dir: "ltr" | "rtl";
  FlagIcon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  /** codice lingua osTicket (staff.lang, system_language) */
  osticket: string;
}

export const languages: Language[] = [
  { id: "it", name: "Italiano", shortName: "IT", dir: "ltr", FlagIcon: ItFlagIcon, osticket: "it" },
  { id: "en", name: "English", shortName: "EN", dir: "ltr", FlagIcon: UsFlagIcon, osticket: "en_US" },
];

function getLanguage(locale: Locale): Language {
  return languages.find((l) => l.id === locale) || languages[0];
}

export function isRtl(locale: Locale): boolean {
  return getLanguage(locale).dir === "rtl";
}
