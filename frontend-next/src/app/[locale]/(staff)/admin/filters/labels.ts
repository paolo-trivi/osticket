import "server-only";

import { getTranslations } from "next-intl/server";

/** Etichette dei campi del filtro per gli errori (rule_<i> → "Regola i+1"). */
export async function filterLabels(): Promise<Record<string, string>> {
  const t = await getTranslations("asys.filters");
  const out: Record<string, string> = { name: t("name"), execorder: t("order"), target: t("target"), rules: t("sections.rules") };
  for (let i = 0; i < 50; i++) out[`rule_${i}`] = t("ruleN", { n: i + 1 });
  return out;
}
