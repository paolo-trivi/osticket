import { setRequestLocale } from "next-intl/server";

import { requireAdmin } from "../../guard";
import SettingsView from "../_shared/SettingsView";

/** Impostazioni › tickets (scp/settings.php?t=tickets). */
export default async function TicketsSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  return <SettingsView page="tickets" slug="tickets" />;
}
