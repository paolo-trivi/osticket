import { setRequestLocale } from "next-intl/server";

import { requireAdmin } from "../../guard";
import SettingsView from "../_shared/SettingsView";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("usersSettings");

/** Impostazioni › users (scp/settings.php?t=users). */
export default async function UsersSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  return <SettingsView page="users" slug="users" />;
}
