"use server";

import type { SysFormState } from "@/components/adminsys/SysForm";
import { massRedirect, sysFormResult } from "@/server/actions/result";
import { str } from "@/server/php/values";
import { massApiKeys, saveApiKey, type ApiKeyMassAction } from "@/server/domain/adminsys/apikey";

import { adminWrite, parsePhpForm, requireAdminAction, selectedIds } from "../_sys/server";

/** scp/apikeys.php do=add / do=update */
export async function saveApiKeyAction(keyId: number | null, _prev: SysFormState, form: FormData): Promise<SysFormState> {
  const { locale } = await requireAdminAction();
  const r = await adminWrite((tx) => saveApiKey(tx, keyId, parsePhpForm(form)));
  return sysFormResult(r, { locale, created: keyId ? undefined : (id) => `/admin/apikeys/${id}?ok=created` });
}

const ACTIONS: ApiKeyMassAction[] = ["enable", "disable", "delete"];

/** scp/apikeys.php do=mass_process */
export async function massApiKeyAction(form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const a = str(vars.a) as ApiKeyMassAction;
  if (!ACTIONS.includes(a)) massRedirect("/admin/apikeys", locale, { ok: false, num: 0, error: "unknown_action" }, a);
  const r = await adminWrite((tx) => massApiKeys(tx, a, selectedIds(vars)));
  massRedirect("/admin/apikeys", locale, r, a);
}
