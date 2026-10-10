import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";

/** Voci del menu Admin il cui nome da solo è ambiguo nel titolo della scheda ("Ticket", "Agenti"…). */
const SETTINGS_KEYS = new Set(["company", "systemSettings", "ticketsSettings", "tasksSettings", "agentsSettings", "usersSettings", "kbSettings"]);

/**
 * Titolo della scheda per le pagine dell'area admin: il nome della voce di menu (adminNav) della sezione,
 * lo stesso per elenco, creazione e modifica; le pagine delle impostazioni aggiungono "Impostazioni".
 * "home" e "theme" sono le due voci che nel menu non vengono da adminNav.
 */
export function adminMetadata(key: string): () => Promise<Metadata> {
  return async () => {
    const t = await getTranslations();
    if (key === "home") return { title: t("admin.home") };
    if (key === "theme") return { title: t("admin.theme.title") };
    const label = t(`adminNav.${key}` as never);
    return {
      title: SETTINGS_KEYS.has(key) ? `${label} · ${t("nav.items.settings")}` : label,
    };
  };
}
