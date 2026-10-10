import "server-only";

import { redirect } from "@/i18n/navigation";
import { currentClient } from "@/server/auth/client-auth";
import { coreConfig } from "@/server/config/config";
import { kbEnabled } from "@/server/domain/client/kb";

import { portalVisitor } from "../guard";

/** kb/kb.inc.php: knowledge base disattivata o senza FAQ pubblicate → home del portale */
export async function requireKb(locale: string): Promise<void> {
  const [cfg, client] = await Promise.all([coreConfig(), portalVisitor(locale)]);
  if (!(await kbEnabled(cfg, client))) redirect({ href: "/", locale });
}

/** Per generateMetadata: la knowledge base è visibile al visitatore (senza redirect). */
export async function kbVisible(): Promise<boolean> {
  const [cfg, client] = await Promise.all([coreConfig(), currentClient()]);
  return kbEnabled(cfg, client);
}
