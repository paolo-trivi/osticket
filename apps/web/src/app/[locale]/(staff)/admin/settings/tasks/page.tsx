import { setRequestLocale } from "next-intl/server";

import { requireAdmin } from "../../guard";
import SettingsView from "../_shared/SettingsView";

/** Impostazioni › tasks (scp/settings.php?t=tasks). */
export default async function TasksSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  return <SettingsView page="tasks" slug="tasks" />;
}
