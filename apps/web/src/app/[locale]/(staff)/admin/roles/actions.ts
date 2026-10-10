"use server";

import type { AdminFormState } from "@/lib/admin/form-schema";
import { adminFormResult, massRedirect } from "@/server/actions/result";
import { parsePhpForm, selectedIds } from "@/server/domain/admin/form-data";
import { str } from "@/server/php/values";
import { massRoles, saveRole, type RoleMassAction } from "@/server/domain/admin/role";

import { adminWrite, requireAdminAction } from "../_shared/server";

/** scp/roles.php do=update / do=add */
export async function saveRoleAction(roleId: number | null, _prev: AdminFormState, form: FormData): Promise<AdminFormState> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const r = await adminWrite((tx) => saveRole(tx, roleId, vars));
  return adminFormResult(r, { locale, created: roleId ? undefined : (id) => `/admin/roles/${id}?created=1` });
}

const ACTIONS: RoleMassAction[] = ["enable", "disable", "delete"];

/** scp/roles.php do=mass_process */
export async function massRolesAction(form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const a = str(vars.a) as RoleMassAction;
  if (!ACTIONS.includes(a)) massRedirect("/admin/roles", locale, { ok: false, num: 0, error: "unknown" }, a);
  const r = await adminWrite((tx) => massRoles(tx, a, selectedIds(vars)));
  massRedirect("/admin/roles", locale, r, a);
}
