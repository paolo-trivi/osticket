import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";

import AppShell from "@/components/shell/AppShell";
import WriteModeBanner from "@/components/shell/WriteModeBanner";
import { WriteModeProvider } from "@/context/WriteModeContext";
import { writeAllowed } from "@/server/system/write-mode";
import { uiWriteMode } from "@/server/system/write-mode-ui";

import { agentLogoutAction } from "../actions";
import { requireAgent } from "../guard";
import { agentNav, shellUser } from "../nav";

export const dynamic = "force-dynamic";

export default async function AgentPanelLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  // il layout contiene anche il profilo: il cambio password obbligatorio lo controlla ogni pagina
  const agent = await requireAgent(locale, { passwordChange: true });

  const t = await getTranslations();
  const legacyUrl = process.env.OST_PHP_URL;
  // modalità di scrittura effettiva: banner e azioni disattivate in sola lettura (il gate è sul server)
  const wm = await uiWriteMode();
  return (
    <WriteModeProvider configured={wm.configured} effective={wm.effective} reasons={wm.reasons}>
      <AppShell
        sections={await agentNav(agent, writeAllowed(wm.effective, "operational"))}
        homeHref="/agent"
        user={await shellUser(agent)}
        searchHref="/agent/tickets"
        logoutAction={agentLogoutAction}
        menuLinks={[
          { label: t("header.profile"), href: "/agent/profile" },
          ...(legacyUrl
            ? [
                {
                  label: t("common.legacyPanel"),
                  href: `${legacyUrl}/scp/`,
                  external: true,
                },
              ]
            : []),
        ]}
        banner={<WriteModeBanner area="agent" legacyUrl={legacyUrl} />}
      >
        {children}
      </AppShell>
    </WriteModeProvider>
  );
}
