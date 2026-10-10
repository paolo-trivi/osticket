"use server";

import type { AdminFormState } from "@/lib/admin/form-schema";
import { adminFormResult, massRedirect } from "@/server/actions/result";
import { checkPasswordPolicy } from "@/server/domain/directory/accounts";
import { parsePhpForm, selectedIds } from "@/server/domain/admin/form-data";
import { str, truthy, type PhpVars } from "@/server/php/values";
import { saveStaff } from "@/server/domain/admin/staff-admin";
import { massStaff, type StaffMassAction } from "@/server/domain/admin/staff-mass";
import { setAgentPassword } from "@/server/domain/admin/staff-password";

import { adminWrite, requireAdminAction } from "../_shared/server";

/**
 * scp/staff.php do=update / do=create. Alla creazione il PHP prende la password dal dialogo
 * "Imposta password" (PasswordResetForm, sessione new-agent-passwd) oppure invia l'email di
 * benvenuto se il backend è quello locale: qui il dialogo è nella stessa pagina.
 */
export async function saveAgentAction(staffId: number | null, _prev: AdminFormState, form: FormData): Promise<AdminFormState> {
  const { agent, ip, locale } = await requireAdminAction();
  const vars: PhpVars = parsePhpForm(form);
  if (!staffId) {
    const welcome = truthy(vars.welcome_email);
    delete vars.welcome_email;
    if (!welcome) {
      // PasswordResetForm: password obbligatorie, politica, conferma
      const p1 = str(vars.passwd1);
      const p2 = str(vars.passwd2);
      const errors: Record<string, string> = {};
      if (!p1) errors.passwd1 = "required";
      else {
        const pe = checkPasswordPolicy(p1, null);
        if (pe) errors.passwd1 = pe;
      }
      if (!p2) errors.passwd2 = "required";
      else if (!errors.passwd1 && p1 !== p2) errors.passwd1 = "mismatch";
      if (Object.keys(errors).length) return { status: "error", errors, nonce: Date.now() };
      vars.welcome_email = "";
    } else {
      delete vars.passwd1;
      delete vars.passwd2;
      delete vars.change_passwd;
      const bk = vars.backend;
      if (!truthy(bk) || bk === "local") vars.welcome_email = 1;
    }
  }
  const r = await adminWrite((tx) => saveStaff(tx, staffId, vars, { actorId: agent.id, ip }));
  return adminFormResult(r, { locale, created: staffId ? undefined : (id) => `/admin/agents/${id}?created=1` });
}

/** ajax.staff.php setPassword: email di reset oppure nuova password. */
export async function agentPasswordAction(staffId: number, _prev: AdminFormState, form: FormData): Promise<AdminFormState> {
  const { ip } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const r = await adminWrite((tx) =>
    setAgentPassword(
      tx,
      staffId,
      { welcome_email: truthy(vars.welcome_email), passwd1: str(vars.passwd1), passwd2: str(vars.passwd2), change_passwd: truthy(vars.change_passwd) },
      ip,
    ),
  );
  if (!r.ok) return { status: "error", errors: r.errors, nonce: Date.now() };
  return { status: "saved", nonce: Date.now() };
}

const ACTIONS: StaffMassAction[] = ["enable", "disable", "delete", "permissions", "department"];

/** scp/staff.php do=mass_process */
export async function massAgentsAction(form: FormData): Promise<void> {
  const { agent, locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const a = str(vars.a) as StaffMassAction;
  if (!ACTIONS.includes(a)) massRedirect("/admin/agents", locale, { ok: false, num: 0, error: "unknown" }, a);
  const r = await adminWrite((tx) => massStaff(tx, a, selectedIds(vars), agent.id, vars));
  massRedirect("/admin/agents", locale, r, a);
}
