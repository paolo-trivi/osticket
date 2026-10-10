import { setRequestLocale } from "next-intl/server";

import { requireAdmin } from "../../guard";
import SettingsView from "../_shared/SettingsView";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("agentsSettings");

/** Impostazioni › agents (scp/settings.php?t=agents). */
export default async function AgentsSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  return <SettingsView page="agents" slug="agents" />;
}
