import "server-only";

import { cache } from "react";
import { coreConfig, loadConfigNamespace } from "../config/config";
import { NOW, db } from "../db";
import { stripFourByteChars } from "../format/html";
import { DEFAULT_THEME, ThemeSchema, type ThemeSettings } from "@/lib/theme/schema";

export { DEFAULT_THEME,  themeCss,  } from "@/lib/theme/schema";

/**
 * Tema della nuova interfaccia, configurabile dall'area admin.
 * Persistenza: tabella `config` di osTicket, namespace dedicato (nessuna modifica di schema;
 * il PHP ignora i namespace che non conosce, come fa per quelli dei plugin).
 * I loghi sono quelli già gestiti da osTicket (Admin > Impostazioni > Sistema/Logo):
 * config core.staff_logo_id, core.client_logo_id, core.staff_backdrop_id.
 */
const THEME_NAMESPACE = "nextui.theme";

export interface ResolvedTheme extends ThemeSettings {
  /** nome mostrato: app_name oppure core.helpdesk_title */
  displayName: string;
  staffLogoId: number;
  clientLogoId: number;
  backdropId: number;
}

function parseValue(key: keyof ThemeSettings, raw: string): unknown {
  const def = DEFAULT_THEME[key];
  if (typeof def === "boolean") return raw === "1" || raw === "true";
  return raw;
}

export const loadTheme = cache(async (): Promise<ResolvedTheme> => {
  const [ns, core] = await Promise.all([loadConfigNamespace(THEME_NAMESPACE), coreConfig()]);
  const candidate: Record<string, unknown> = { ...DEFAULT_THEME };
  for (const key of Object.keys(DEFAULT_THEME) as (keyof ThemeSettings)[]) {
    if (ns.has(key)) candidate[key] = parseValue(key, ns.str(key));
  }
  // valori non validi nel DB (modificati a mano) → default, campo per campo
  const settings = { ...DEFAULT_THEME };
  for (const key of Object.keys(DEFAULT_THEME) as (keyof ThemeSettings)[]) {
    const parsed = ThemeSchema.shape[key].safeParse(candidate[key]);
    if (parsed.success) (settings as Record<string, unknown>)[key] = parsed.data;
  }
  return {
    ...settings,
    displayName: settings.app_name || core.str("helpdesk_title") || "TailTicket",
    staffLogoId: settings.use_osticket_logos ? core.int("staff_logo_id") : 0,
    clientLogoId: settings.use_osticket_logos ? core.int("client_logo_id") : 0,
    backdropId: settings.use_osticket_logos ? core.int("staff_backdrop_id") : 0,
  };
});

/** Salva il tema: stessa semantica di Config::set() PHP (update se esiste, altrimenti insert). */
export async function saveTheme(input: ThemeSettings): Promise<void> {
  const settings = ThemeSchema.parse(input);
  await db()
    .transaction()
    .execute(async (tx) => {
      const existing = await tx
        .selectFrom("config")
        .select(["id", "key", "value"])
        .where("namespace", "=", THEME_NAMESPACE)
        .execute();
      const byKey = new Map(existing.map((r) => [r.key, r]));
      for (const [key, value] of Object.entries(settings)) {
        const str = typeof value === "boolean" ? (value ? "1" : "0") : stripFourByteChars(String(value));
        const row = byKey.get(key);
        if (!row) {
          await tx.insertInto("config").values({ namespace: THEME_NAMESPACE, key, value: str, updated: NOW }).execute();
        } else if (row.value !== str) {
          await tx.updateTable("config").set({ value: str, updated: NOW }).where("id", "=", row.id).execute();
        }
      }
    });
}
