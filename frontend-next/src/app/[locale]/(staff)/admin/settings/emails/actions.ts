"use server";

import type { SysFormState } from "@/components/adminsys/SysForm";
import { updateEmailsSettings } from "@/server/domain/adminsys/email-settings";

import { adminWrite, formResult, parsePhpForm, requireAdminAction } from "../../_sys/server";

/** scp/emailsettings.php (POST) → OsticketConfig::updateSettings con t=emails */
export async function saveEmailsSettingsAction(_prev: SysFormState, form: FormData): Promise<SysFormState> {
  const { locale } = await requireAdminAction();
  const vars = { ...parsePhpForm(form), t: "emails" };
  const r = await adminWrite((tx) => updateEmailsSettings(tx, vars));
  return formResult(r, { locale });
}
