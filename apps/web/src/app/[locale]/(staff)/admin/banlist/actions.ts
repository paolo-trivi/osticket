"use server";

import type { SysFormState } from "@/components/adminsys/SysForm";
import { massRedirect, sysFormResult } from "@/server/actions/result";
import { str } from "@/server/domain/admin/php";
import { addBanRule, massBanRules, updateBanRule, type BanMassAction } from "@/server/domain/adminsys/banlist";

import { adminWrite, parsePhpForm, requireAdminAction, selectedIds } from "../_sys/server";

/** scp/banlist.php do=add */
export async function addBanAction(_prev: SysFormState, form: FormData): Promise<SysFormState> {
  const { locale } = await requireAdminAction();
  const r = await adminWrite((tx) => addBanRule(tx, parsePhpForm(form)));
  return sysFormResult(r, { locale });
}

/** scp/banlist.php do=update */
export async function updateBanAction(ruleId: number, _prev: SysFormState, form: FormData): Promise<SysFormState> {
  const { locale } = await requireAdminAction();
  const r = await adminWrite((tx) => updateBanRule(tx, ruleId, parsePhpForm(form)));
  return sysFormResult(r, { locale });
}

const ACTIONS: BanMassAction[] = ["enable", "disable", "delete"];

/** scp/banlist.php do=mass_process */
export async function massBanAction(form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const a = str(vars.a) as BanMassAction;
  if (!ACTIONS.includes(a)) massRedirect("/admin/banlist", locale, { ok: false, num: 0, error: "unknown_action" }, a);
  const r = await adminWrite((tx) => massBanRules(tx, a, selectedIds(vars)));
  massRedirect("/admin/banlist", locale, r, a);
}
