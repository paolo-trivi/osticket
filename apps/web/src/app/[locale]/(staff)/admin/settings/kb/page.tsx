import { setRequestLocale } from "next-intl/server";

import { requireAdmin } from "../../guard";
import SettingsView from "../_shared/SettingsView";

/** Impostazioni › kb (scp/settings.php?t=kb). */
export default async function KbSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  return <SettingsView page="kb" slug="kb" />;
}
