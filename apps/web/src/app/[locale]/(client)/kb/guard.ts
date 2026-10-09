import "server-only";

import { redirect } from "@/i18n/navigation";
import { currentClient } from "@/server/auth/client-auth";
import { coreConfig } from "@/server/config/config";
import { kbEnabled } from "@/server/domain/client/kb";

/** kb/kb.inc.php: knowledge base disattivata o senza FAQ pubblicate → home del portale */
export async function requireKb(locale: string): Promise<void> {
  const [cfg, client] = await Promise.all([coreConfig(), currentClient()]);
  if (!(await kbEnabled(cfg, client))) redirect({ href: "/", locale });
}
