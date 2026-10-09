"use server";

import type { SysFormState } from "@/components/adminsys/SysForm";
import { str } from "@/server/domain/admin/php";
import { massFilters, saveFilter, type FilterMassAction } from "@/server/domain/adminsys/filter";

import { adminWrite, formResult, massRedirect, parsePhpForm, requireAdminAction, selectedIds } from "../_sys/server";

/** scp/filters.php do=add / do=update */
export async function saveFilterAction(filterId: number | null, _prev: SysFormState, form: FormData): Promise<SysFormState> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const r = await adminWrite((tx) => saveFilter(tx, filterId, vars));
  // senza actions[] il PHP fallisce senza messaggi: errore generico
  if (!r.ok && !Object.keys(r.errors).length) r.errors.err = vars.actions ? "failed" : "action_required";
  return formResult(r, { locale, created: filterId ? undefined : (id) => `/admin/filters/${id}?ok=created` });
}

const ACTIONS: FilterMassAction[] = ["enable", "disable", "delete"];

/** scp/filters.php do=mass_process */
export async function massFilterAction(form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const a = str(vars.a) as FilterMassAction;
  if (!ACTIONS.includes(a)) massRedirect("/admin/filters", locale, { ok: false, num: 0, error: "unknown_action" }, a);
  const r = await adminWrite((tx) => massFilters(tx, a, selectedIds(vars)));
  massRedirect("/admin/filters", locale, r, a);
}
