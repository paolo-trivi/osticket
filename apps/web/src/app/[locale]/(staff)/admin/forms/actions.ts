"use server";

import type { SysFormState } from "@/components/adminsys/SysForm";
import { deleteForms, saveForm } from "@/server/domain/adminsys/form";

import { adminWrite, formResult, massRedirect, parsePhpForm, requireAdminAction, selectedIds } from "../_sys/server";

/** scp/forms.php do=add / do=update */
export async function saveFormAction(formId: number | null, _prev: SysFormState, form: FormData): Promise<SysFormState> {
  const { locale } = await requireAdminAction();
  const r = await adminWrite((tx) => saveForm(tx, formId, parsePhpForm(form)));
  return formResult(r, { locale, created: formId ? undefined : (id) => `/admin/forms/${id}?ok=created` });
}

/** scp/forms.php do=mass_process a=delete */
export async function massFormAction(form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const r = await adminWrite((tx) => deleteForms(tx, selectedIds(parsePhpForm(form))));
  massRedirect("/admin/forms", locale, r, "delete");
}
