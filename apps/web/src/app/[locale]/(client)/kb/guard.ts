import "server-only";

import { redirect } from "@/i18n/navigation";
import { coreConfig } from "@/server/config/config";
import { kbEnabled } from "@/server/domain/client/kb";

import { portalVisitor } from "../guard";

/** kb/kb.inc.php: knowledge base disattivata o senza FAQ pubblicate → home del portale */
export async function requireKb(locale: string): Promise<void> {
  const [cfg, client] = await Promise.all([coreConfig(), portalVisitor(locale)]);
  if (!(await kbEnabled(cfg, client))) redirect({ href: "/", locale });
}
