"use server";

import type { AdminFormState } from "@/lib/admin/form-schema";
import { parsePhpForm, selectedIds } from "@/server/domain/admin/form-data";
import { str } from "@/server/domain/admin/php";
import { massSla, saveSla, type SlaMassAction } from "@/server/domain/admin/sla";

import { adminWrite, formResult, massRedirect, requireAdminAction } from "../_shared/server";

/** scp/slas.php do=update / do=add */
export async function saveSlaAction(slaId: number | null, _prev: AdminFormState, form: FormData): Promise<AdminFormState> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const r = await adminWrite((tx) => saveSla(tx, slaId, vars));
  return formResult(r, { path: "/admin/sla", locale, created: slaId ? undefined : (id) => `/admin/sla/${id}?created=1` });
}

const ACTIONS: SlaMassAction[] = ["enable", "disable", "delete"];

/** scp/slas.php do=mass_process */
export async function massSlaAction(form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const a = str(vars.a) as SlaMassAction;
  if (!ACTIONS.includes(a)) massRedirect("/admin/sla", locale, { ok: false, num: 0, error: "unknown" }, a);
  const r = await adminWrite((tx) => massSla(tx, a, selectedIds(vars)));
  massRedirect("/admin/sla", locale, r, a);
}
