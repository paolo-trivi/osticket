import type { ReactNode } from "react";

import { getTranslations, setRequestLocale } from "next-intl/server";

import PortalHeader, { type PortalNavItem } from "@/components/portal/PortalHeader";
import { WriteModeProvider } from "@/context/WriteModeContext";
import { sessionClient } from "@/server/auth/client-auth";
import { coreConfig } from "@/server/config/config";
import { clientDisplayName } from "@/server/domain/client/identity";
import { kbEnabled } from "@/server/domain/client/kb";
import { uiWriteMode } from "@/server/system/write-mode-ui";
import { loadTheme } from "@/server/theme/theme";

import { portalLogoutAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Guscio pubblico del portale clienti (include/client/header.inc.php + footer.inc.php): logo del
 * portale (client_logo_id), menu come UserNav (home, knowledge base, apri ticket, i miei ticket o
 * verifica stato, profilo) e accesso/uscita.
 */
export default async function PortalLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  // anche con il cambio password obbligatorio: l'intestazione mostra l'utente e il logout
  const [client, cfg, theme, t, wm] = await Promise.all([sessionClient(), coreConfig(), loadTheme(), getTranslations("portal"), uiWriteMode()]);
  const registration = cfg.str("client_registration");
  const items: PortalNavItem[] = [{ key: "home", href: "/" }];
  if (await kbEnabled(cfg, client)) items.push({ key: "kb", href: "/kb" });
  if (registration !== "disabled" || !cfg.bool("clients_only")) items.push({ key: "open", href: "/open" });
  if (client) {
    items.push({ key: "tickets", href: client.guest ? `/tickets/${client.guest.ticketId}` : "/tickets" });
    if (!client.guest) items.push({ key: "profile", href: "/profile" });
  } else items.push({ key: "status", href: "/login#access" });

  // modalità di scrittura effettiva: in sola lettura l'intestazione avvisa e i form lasciano il posto a un
  // avviso. I motivi (dettagli tecnici) non arrivano ai clienti.
  return (
    <WriteModeProvider configured={wm.configured} effective={wm.effective} reasons={[]}>
      <div className="flex min-h-screen flex-col bg-gray-50 dark:bg-gray-900">
        <PortalHeader
          items={items}
          user={client ? { name: clientDisplayName(client, cfg), guest: !!client.guest } : null}
          showLogin={registration !== "disabled"}
          logoutAction={portalLogoutAction}
        />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
        <footer className="border-t border-gray-200 bg-white py-6 text-center text-theme-xs text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
          <p>
            {t("footer.copyright", {
              year: new Date().getFullYear(),
              name: theme.displayName,
            })}
          </p>
          <p className="mt-1">{t("footer.powered")}</p>
        </footer>
      </div>
    </WriteModeProvider>
  );
}
