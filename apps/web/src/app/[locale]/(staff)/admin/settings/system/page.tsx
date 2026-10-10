import { setRequestLocale } from "next-intl/server";

import { requireAdmin } from "../../guard";
import SettingsView from "../_shared/SettingsView";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("systemSettings");

/** Impostazioni › system (scp/settings.php?t=system). */
export default async function SystemSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  return <SettingsView page="system" slug="system" />;
}
