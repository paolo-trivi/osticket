"use server";

import { randomBytes } from "node:crypto";

import { getLocale } from "next-intl/server";

import { redirect } from "@/i18n/navigation";
import type { DynamicFormView } from "@/lib/forms/dynamic-field";
import { FormType } from "@/lib/osticket/object-types";
import { formNum, formStr, formStrs } from "@/server/actions/form-data";
import { isPortalPath, safeRedirectPath } from "@/server/actions/redirect-path";
import {
  clientLogout,
  clientMustChangePassword,
  clientResetToken,
  currentClient,
  passwordChangePending,
  refreshClientSession,
  sessionClient,
  startClientSession,
  touchClientSession,
  visitorKey,
} from "@/server/auth/client-auth";
import { clientIp } from "@/server/auth/session";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { registerClientAccount, updateClientProfile, type AccountFieldError } from "@/server/domain/client/account";
import type { ClientAuthError } from "@/server/domain/client/auth";
import { performAccessLink } from "@/server/domain/client/auth-access-link";
import { performClientLogin } from "@/server/domain/client/auth-login";
import { performResetTokenLogin } from "@/server/domain/client/auth-reset";
import { requestClientPasswordReset } from "@/server/domain/client/password-reset";
import { openPortalTicket } from "@/server/domain/client/open";
import { editClientTicket, postClientMessage } from "@/server/domain/client/reply";
import { thankYouHtml } from "@/server/domain/client/ui";
import { verifyUploadTokens } from "@/server/domain/file/upload";
import { loadFormDef, loadTopicForms } from "@/server/domain/forms/load";
import { formDataToVars, topicFormsView } from "@/server/domain/ticket/create-ui";

/**
 * Server Actions del portale clienti. Ogni azione ricontrolla la sessione del cliente; i redirect
 * accettano solo percorsi interni del portale. Con il cambio password obbligatorio (client.inc.php)
 * sono ammessi solo il profilo e il logout: currentClient è null e le azioni da visitatore sono negate.
 */

export interface PortalLoginState {
  error?: ClientAuthError;
  login?: string;
}

/** login.php (luser/lpasswd) */
export async function portalLoginAction(_prev: PortalLoginState, fd: FormData): Promise<PortalLoginState> {
  const login = formStr(fd, "login");
  const res = await performClientLogin({ login, password: formStr(fd, "password"), ip: await clientIp() });
  if (!res.ok) return { error: res.error, login };
  await startClientSession(res);
  const locale = await getLocale();
  // client.inc.php: cambio password obbligatorio prima di continuare
  const client = await sessionClient();
  if (client && clientMustChangePassword(client)) redirect({ href: "/profile?pwchange=1", locale });
  redirect({ href: safeRedirectPath(formStr(fd, "next"), "/tickets", isPortalPath), locale });
  return {};
}

export interface AccessLinkState {
  error?: ClientAuthError;
  sent?: boolean;
  email?: string;
  number?: string;
}

/** login.php (lemail/lticket): link via email o accesso diretto come ospite */
export async function accessLinkAction(_prev: AccessLinkState, fd: FormData): Promise<AccessLinkState> {
  const email = formStr(fd, "email").trim();
  const number = formStr(fd, "number").trim();
  const res = await performAccessLink({ email, number, ip: await clientIp() });
  if (!res.ok) return { error: res.error, email, number };
  if (res.sent) return { sent: true };
  await startClientSession(res);
  redirect({ href: `/tickets/${res.guest?.ticketId ?? ""}`, locale: await getLocale() });
  return {};
}

export async function portalLogoutAction(): Promise<void> {
  await clientLogout();
  redirect({ href: "/", locale: await getLocale() });
}

export interface RegisterState {
  error?: string;
  fields?: Record<string, AccountFieldError>;
  values?: Record<string, string>;
  done?: boolean;
}

const ACCOUNT_KEYS = new Set(["passwd1", "passwd2", "cpasswd", "timezone", "lang"]);

/** Campi del form utente (per nome) + preferenze dell'account dal POST */
async function accountVars(fd: FormData): Promise<Record<string, unknown>> {
  const cfg = await coreConfig();
  const user = await loadFormDef(db(), cfg, { type: FormType.USER }, "client");
  const vars: Record<string, unknown> = formDataToVars(fd, [user]);
  for (const k of ACCOUNT_KEYS) if (fd.has(k)) vars[k] = formStr(fd, k);
  return vars;
}

function plainValues(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && !k.startsWith("$ACTION") && !k.startsWith("passwd") && k !== "cpasswd") out[k] = v;
  return out;
}

/** account.php do=create */
export async function registerAction(_prev: RegisterState, fd: FormData): Promise<RegisterState> {
  if (await passwordChangePending()) return { error: "already" };
  const client = await currentClient();
  if (client && !client.guest) return { error: "already" };
  const vars = await accountVars(fd);
  const res = await registerClientAccount(vars, client?.guest ? client : null);
  if (!res.ok) return { error: res.err ?? "unable", fields: res.fields, values: plainValues(fd) };
  return { done: true };
}

export interface ResetState {
  sent?: boolean;
  error?: string;
}

/** pwreset.php do=sendmail */
export async function pwresetRequestAction(_prev: ResetState, fd: FormData): Promise<ResetState> {
  const cfg = await coreConfig();
  if (!cfg.bool("allow_pw_reset")) return { error: "disabled" };
  const res = await requestClientPasswordReset(formStr(fd, "userid"));
  if (!res.ok) return { error: res.error };
  return { sent: true };
}

/** pwreset.php do=reset (nome utente + token del link) */
export async function pwresetLoginAction(_prev: ResetState, fd: FormData): Promise<ResetState> {
  const res = await performResetTokenLogin({ userid: formStr(fd, "userid"), token: formStr(fd, "token"), ip: await clientIp() });
  // un solo errore per utente o token sbagliati (il PHP risponde sempre "Unknown user"): niente enumerazione
  if (!res.ok) return { error: res.error === "invalid_user" ? "invalid_token" : res.error };
  await startClientSession(res);
  redirect({ href: "/profile?pwchange=1", locale: await getLocale() });
  return {};
}

export interface ProfileState {
  error?: string;
  fields?: Record<string, AccountFieldError>;
  values?: Record<string, string>;
  saved?: boolean;
}

/** profile.php POST */
export async function profileAction(_prev: ProfileState, fd: FormData): Promise<ProfileState> {
  // ammessa anche con il cambio password obbligatorio (è il suo scopo)
  const client = await sessionClient();
  if (!client) return { error: "session" };
  if (client.guest) return { error: "guest" };
  const vars = await accountVars(fd);
  const res = await updateClientProfile(client, vars, await clientResetToken());
  if (!res.ok) return { error: res.err ?? "profile", fields: res.fields, values: plainValues(fd) };
  if (res.passwordChanged) await refreshClientSession(res.pwv);
  else await touchClientSession();
  redirect({ href: "/tickets", locale: await getLocale() });
  return { saved: true };
}

export interface ReplyState {
  error?: string;
  nonce?: number;
}

/** tickets.php a=reply */
export async function replyAction(_prev: ReplyState, fd: FormData): Promise<ReplyState> {
  const client = await currentClient();
  if (!client) return { error: "session", nonce: Date.now() };
  const ticketId = formNum(fd, "ticketId");
  const message = formStr(fd, "message");
  const files = verifyUploadTokens(formStrs(fd, "files"), `U${client.id}`);
  const cfg = await coreConfig();
  const res = await postClientMessage(cfg, client, ticketId, { message, files, ip: await clientIp() });
  if ("error" in res) return { error: res.error, nonce: Date.now() };
  await touchClientSession();
  redirect({ href: `/tickets/${ticketId}?posted=1#reply`, locale: await getLocale() });
  return {};
}

export interface EditState {
  error?: string;
  fieldErrors?: Record<number, string[]>;
  values?: Record<string, string[]>;
}

/** tickets.php a=edit (solo il proprietario) */
export async function editTicketAction(_prev: EditState, fd: FormData): Promise<EditState> {
  const client = await currentClient();
  if (!client) return { error: "session" };
  const ticketId = formNum(fd, "ticketId");
  const cfg = await coreConfig();
  const entries = await db().selectFrom("form_entry").select("form_id").where("object_type", "=", FormType.TICKET).where("object_id", "=", ticketId).execute();
  const defs = await Promise.all(entries.map((e) => loadFormDef(db(), cfg, { id: e.form_id }, "client")));
  const vars = formDataToVars(fd, defs);
  const res = await editClientTicket(cfg, client, ticketId, vars, await clientIp());
  if ("error" in res) {
    const values: Record<string, string[]> = {};
    for (const [k, v] of fd.entries()) if (typeof v === "string") (values[k] ??= []).push(v);
    return { error: res.error, fieldErrors: res.error === "invalid" ? res.fields : undefined, values };
  }
  redirect({ href: `/tickets/${ticketId}`, locale: await getLocale() });
  return {};
}

export interface OpenState {
  error?: string;
  errors?: Record<string, string>;
  fieldErrors?: Record<number, string[]>;
  values?: Record<string, string[]>;
  created?: { number: string; html: string | null };
  nonce?: number;
}

/** open.php POST: Ticket::create 'Web' per il cliente o un ospite */
export async function openTicketAction(_prev: OpenState, fd: FormData): Promise<OpenState> {
  if (await passwordChangePending()) return { error: "session", nonce: Date.now() };
  const client = await currentClient();
  const cfg = await coreConfig();
  const topicId = formNum(fd, "topicId") || 0;
  const [ticketDef, userDef, topicForms] = await Promise.all([
    loadFormDef(db(), cfg, { type: FormType.TICKET }, "client"),
    client ? Promise.resolve(null) : loadFormDef(db(), cfg, { type: FormType.USER }, "client"),
    topicId ? loadTopicForms(db(), cfg, topicId, "client") : Promise.resolve([]),
  ]);
  const vars: Record<string, unknown> = formDataToVars(fd, [ticketDef, userDef, ...topicForms.filter((f) => f.type !== FormType.TICKET)]);
  if (topicId) vars.topicId = topicId;
  const key = (await visitorKey()) || randomBytes(16).toString("hex");
  vars.files = verifyUploadTokens(formStrs(fd, "files"), client ? `U${client.id}` : `G${key}`);
  const res = await openPortalTicket(cfg, client, vars, { ip: await clientIp(), sessionKey: key });
  const values: Record<string, string[]> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && !k.startsWith("$ACTION") && k !== "files") (values[k] ??= []).push(v);
  if ("denied" in res) return { error: res.denied, values, nonce: Date.now() };
  if (res.ok) {
    if (client) redirect({ href: `/tickets/${res.ticketId}?created=1`, locale: await getLocale() });
    return { created: { number: res.number, html: await thankYouHtml(cfg, res.ticketId) }, nonce: Date.now() };
  }
  const { err, fields, errno: _errno, ...rest } = res.errors;
  void _errno;
  const errors: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest)) if (v) errors[k] = String(v);
  return { error: err ? (/maximum open tickets/.test(err) ? "limit" : /authorized users only/.test(err) ? "rejected" : "generic") : Object.keys(errors).length || fields ? undefined : "generic", errors, fieldErrors: fields, values, nonce: Date.now() };
}

/** Form aggiuntivi dell'help topic scelto (ajax.php/form/help-topic/<id> lato cliente) */
export async function portalTopicFormsAction(topicId: number): Promise<{ forms: DynamicFormView[]; disabled: number[] }> {
  if (!topicId) return { forms: [], disabled: [] };
  return topicFormsView(db(), await coreConfig(), topicId, "client");
}
