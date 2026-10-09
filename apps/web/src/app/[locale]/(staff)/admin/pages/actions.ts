"use server";

import type { SysFormState } from "@/components/adminsys/SysForm";
import { massRedirect, sysFormResult } from "@/server/actions/result";
import { str } from "@/server/domain/admin/php";
import { massPages, savePage, type PageMassAction } from "@/server/domain/adminsys/page";

import { adminWrite, parsePhpForm, requireAdminAction, selectedIds } from "../_sys/server";

/** scp/pages.php do=add / do=update */
export async function savePageAction(pageId: number | null, _prev: SysFormState, form: FormData): Promise<SysFormState> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  if (pageId) vars.id = String(pageId);
  const r = await adminWrite((tx) => savePage(tx, pageId, vars));
  return sysFormResult(r, { locale, created: pageId ? undefined : (id) => `/admin/pages/${id}?ok=created` });
}

const ACTIONS: PageMassAction[] = ["enable", "disable", "delete"];

/** scp/pages.php do=mass_process */
export async function massPageAction(form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const a = str(vars.a) as PageMassAction;
  if (!ACTIONS.includes(a)) massRedirect("/admin/pages", locale, { ok: false, num: 0, error: "unknown_action" }, a);
  const r = await adminWrite((tx) => massPages(tx, a, selectedIds(vars)));
  massRedirect("/admin/pages", locale, r, a);
}
