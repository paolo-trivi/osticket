"use server";

import type { AdminFormState } from "@/lib/admin/form-schema";
import { adminFormResult, massRedirect } from "@/server/actions/result";
import { massDept, saveDept, type DeptMassAction } from "@/server/domain/admin/dept";
import { parsePhpForm, selectedIds } from "@/server/domain/admin/form-data";
import { str } from "@/server/domain/admin/php";

import { adminWrite, requireAdminAction } from "../_shared/server";

/** scp/departments.php do=update / do=create */
export async function saveDeptAction(deptId: number | null, _prev: AdminFormState, form: FormData): Promise<AdminFormState> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const r = await adminWrite((tx) => saveDept(tx, deptId, vars));
  return adminFormResult(r, { locale, created: deptId ? undefined : (id) => `/admin/departments/${id}?created=1` });
}

const ACTIONS: DeptMassAction[] = ["enable", "disable", "archive", "delete"];

/** scp/departments.php do=mass_process */
export async function massDeptAction(form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const a = str(vars.a) as DeptMassAction;
  if (!ACTIONS.includes(a)) massRedirect("/admin/departments", locale, { ok: false, num: 0, error: "unknown" }, a);
  const r = await adminWrite((tx) => massDept(tx, a, selectedIds(vars)));
  massRedirect("/admin/departments", locale, r, a);
}
