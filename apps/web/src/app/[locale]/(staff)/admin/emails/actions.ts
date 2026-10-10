"use server";

import type { SysFormState } from "@/components/adminsys/SysForm";
import { massRedirect, sysFormResult } from "@/server/actions/result";
import { str } from "@/server/php/values";
import { massDeleteEmails, saveEmail } from "@/server/domain/adminsys/email";
import { saveBasicAuth } from "@/server/domain/adminsys/email-account";
import { sendTestEmail } from "@/server/domain/adminsys/email-test";

import { adminWrite, parsePhpForm, requireAdminAction, selectedIds } from "../_sys/server";

/** scp/emails.php do=update / do=create */
export async function saveEmailAction(emailId: number | null, _prev: SysFormState, form: FormData): Promise<SysFormState> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  if (emailId) vars.id = String(emailId);
  const r = await adminWrite((tx) => saveEmail(tx, emailId, vars));
  return sysFormResult(r, { locale, created: emailId ? undefined : (id) => `/admin/emails/${id}?ok=created` });
}

/** ajax.php/email/<id>/auth/config/<type>/basic: credenziali "basic" dell'account */
export async function saveEmailAuthAction(emailId: number, type: "mailbox" | "smtp", _prev: SysFormState, form: FormData): Promise<SysFormState> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const stash = Object.fromEntries(["host", "port", "protocol"].map((p) => [`${type}_${p}`, vars[`${type}_${p}`]]).filter(([, v]) => v !== undefined));
  const r = await adminWrite((tx) => saveBasicAuth(tx, emailId, type, { username: str(vars.username), passwd: vars.passwd === undefined ? undefined : str(vars.passwd) }, stash));
  return sysFormResult(r, { locale });
}

/** scp/emails.php do=mass_process a=delete */
export async function massEmailAction(form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const r = await adminWrite((tx) => massDeleteEmails(tx, selectedIds(vars)));
  massRedirect("/admin/emails", locale, r, "delete");
}

/** scp/emailtest.php */
export async function sendTestEmailAction(_prev: SysFormState, form: FormData): Promise<SysFormState> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const r = await adminWrite((tx) => sendTestEmail(tx, vars));
  return sysFormResult(r, { locale });
}
