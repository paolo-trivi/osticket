import "server-only";

import { EMAIL_2FA, prepare2faEmail, staff2faConfig, validateOtp, type OtpCheck } from "../../auth/mfa";
import { phpJsonEncode } from "../../format/php-json";
import { isValidEmail } from "../forms/validator";
import type { WriteContext } from "../ticket/context";
import { loadAgent } from "./staff";
import { updateStaffConfig } from "./staff-write";

/** Autenticazione a due fattori via email dal profilo dell'agente (ajax.staff.php configure2FA). */

/**
 * ajax.staff.php:configure2FA stato "validate": salva {config:{email}, verified:0} (se non esterno)
 * e invia il codice. Restituisce la funzione di invio da eseguire dopo il commit.
 */
export async function setup2faEmail(ctx: WriteContext, address: string, key: string): Promise<{ ok: true; send: () => Promise<void> } | { ok: false; error: "invalid" | "send_failed" | "forbidden" }> {
  const { tx, cfg } = ctx;
  if (!ctx.agent) return { ok: false, error: "forbidden" };
  if (!address || !(await isValidEmail(address, cfg.bool("verify_email_addrs")))) return { ok: false, error: "invalid" };
  const current = staff2faConfig(ctx.agent.config);
  if (!current.config?.external2fa) {
    await updateStaffConfig(tx, ctx.agent.id, { [EMAIL_2FA]: phpJsonEncode({ config: { email: address }, verified: 0 }) });
  }
  const agent = await loadAgent(ctx.agent.id, tx);
  if (!agent) return { ok: false, error: "forbidden" };
  const send = await prepare2faEmail(tx, cfg, agent, key);
  if (!send) return { ok: false, error: "send_failed" };
  return { ok: true, send };
}

/** configure2FA stato "verify": codice valido → verified = time(). */
export async function verify2faSetup(ctx: WriteContext, key: string, otp: string, now = Math.floor(Date.now() / 1000)): Promise<OtpCheck> {
  if (!ctx.agent) return "missing";
  const r = validateOtp(key, ctx.agent.id, otp);
  if (r !== "ok") return r;
  const agent = await loadAgent(ctx.agent.id, ctx.tx);
  const conf = agent ? staff2faConfig(agent.config) : {};
  if (agent && Object.keys(conf).length) {
    await updateStaffConfig(ctx.tx, agent.id, { [EMAIL_2FA]: phpJsonEncode({ ...conf, verified: now }) });
  }
  return "ok";
}

/** Valore predefinito del 2FA (impostato dal profilo: default_2fa). */
export async function setDefault2fa(ctx: WriteContext, value: string): Promise<void> {
  if (!ctx.agent) return;
  await updateStaffConfig(ctx.tx, ctx.agent.id, { default_2fa: value });
}
