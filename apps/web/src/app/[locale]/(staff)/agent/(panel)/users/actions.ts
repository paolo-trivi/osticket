"use server";

import { getLocale } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { redirect } from "@/i18n/navigation";
import type { PeopleActionState } from "@/components/people/types";
import { formFlag, formIds, formNum, formStr } from "@/server/actions/form-data";
import { nonce, peopleState } from "@/server/actions/result";
import { clientIp } from "@/server/auth/session";
import { currentAgent } from "@/server/auth/staff-auth";
import { db } from "@/server/db";
import { massUserAction, registerAccount, sendUserConfirmEmail, sendUserResetEmail, updateAccount, type AccountVars, type UserMassAction } from "@/server/domain/directory/accounts";
import { defaultFormOf } from "@/server/domain/directory/forms";
import { createOrg } from "@/server/domain/directory/orgs";
import { formSource } from "@/server/domain/directory/ui";
import { createUser, deleteUser, importUsers, setUserOrganization, updateUser } from "@/server/domain/directory/users";
import { GlobalPerm, type Agent } from "@/server/domain/staff/staff";
import type { WriteContext } from "@/server/domain/ticket/context";
import { deleteTicketViaDeletedStatus } from "@/server/domain/ticket/delete";
import { runWrite } from "@/server/domain/write";

/**
 * Server action della directory utenti (scp/users.php, include/ajax.users.php). I permessi sono
 * ricontrollati nei servizi (user.create/edit/delete/manage); dove il PHP non li controlla si applica
 * il permesso più stretto (annotato nei servizi).
 */

async function run(fn: (ctx: WriteContext, agent: Agent) => Promise<PeopleActionState>, paths: string[] = []): Promise<PeopleActionState> {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired" };
  const r = await runWrite({ agent, ip: await clientIp() }, (ctx) => fn(ctx, agent));
  if (r.ok) for (const p of ["/agent/users", ...paths]) revalidatePath(p);
  return r;
}

async function userFields(form: FormData) {
  const f = await defaultFormOf(db(), "U");
  return formSource(form, f?.fields ?? []);
}

const userId = (form: FormData) => formNum(form, "userId");

/** scp/users.php do=create / ajax.users.php:addUser */
export async function userCreateAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const input = await userFields(form);
  return run(async (ctx) => {
    const r = await createUser(ctx, input);
    return r.ok ? { ok: true, redirect: `/agent/users/${r.id}`, nonce: nonce() } : peopleState(r);
  });
}

/** ajax.users.php:updateUser */
export async function userUpdateAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const id = userId(form);
  const input = await userFields(form);
  return run(async (ctx) => peopleState(await updateUser(ctx, id, input)), [`/agent/users/${id}`]);
}

/** ajax.users.php:delete (con `deletetickets`: User::deleteAllTickets) */
export async function userDeleteAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const id = userId(form);
  const r = await run(async (ctx) => peopleState(await deleteUser(ctx, id, { deleteTickets: formFlag(form, "deletetickets"), hardDeleteTicket: deleteTicketViaDeletedStatus })));
  if (r.ok) redirect({ href: "/agent/users", locale: await getLocale() });
  return r;
}

/** ajax.users.php:updateOrg: organizzazione esistente o nuova (org.create) */
export async function userOrgAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const id = userId(form);
  const orgId = formNum(form, "orgId");
  const newName = formStr(form, "orgName").trim();
  return run(async (ctx) => {
    let target = orgId;
    if (!target) {
      if (!newName) return { error: "invalid", fields: { orgId: "required" }, nonce: nonce() };
      const o = await createOrg(ctx, { name: newName });
      if (!o.ok) return peopleState(o);
      target = o.id;
    }
    return peopleState(await setUserOrganization(ctx, id, target));
  }, [`/agent/users/${id}`, "/agent/orgs"]);
}

function accountVars(form: FormData): AccountVars {
  return {
    username: formStr(form, "username"),
    timezone: formStr(form, "timezone"),
    passwd1: formStr(form, "passwd1"),
    passwd2: formStr(form, "passwd2"),
    ...(formFlag(form, "sendemail") ? { sendemail: true } : {}),
    "pwreset-flag": formFlag(form, "pwreset-flag"),
    "locked-flag": formFlag(form, "locked-flag"),
    "forbid-pwchange-flag": formFlag(form, "forbid-pwchange-flag"),
    "forbid-pwreset-flag": formFlag(form, "forbid-pwreset-flag"),
  };
}

/** ajax.users.php:register */
export async function userRegisterAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const id = userId(form);
  return run(async (ctx) => peopleState(await registerAccount(ctx, id, accountVars(form))), [`/agent/users/${id}`]);
}

/** ajax.users.php:manage (account esistente) */
export async function userAccountAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const id = userId(form);
  return run(async (ctx) => peopleState(await updateAccount(ctx, id, accountVars(form))), [`/agent/users/${id}`]);
}

/**
 * scp/users.php do=confirmlink / do=pwreset. Il PHP richiede solo l'accesso alla directory: qui serve
 * user.manage (regola più stretta).
 */
export async function userSendMailAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const id = userId(form);
  const kind = formStr(form, "kind");
  return run(async (ctx, agent) => {
    if (!agent.hasGlobalPerm(GlobalPerm.USER_MANAGE)) return { error: "forbidden", nonce: nonce() };
    const r = kind === "confirm" ? await sendUserConfirmEmail(ctx, id) : await sendUserResetEmail(ctx, id);
    return r.ok ? { ok: true, notice: kind === "confirm" ? "confirm_sent" : "reset_sent", nonce: nonce() } : peopleState(r);
  }, [`/agent/users/${id}`]);
}

/** scp/users.php do=mass_process (anche per blocco/sblocco del singolo utente) */
export async function userMassAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const ids = formIds(form, "ids");
  if (!ids.length) return { error: "none_selected", nonce: nonce() };
  const action = formStr(form, "do");
  let op: UserMassAction;
  if (action === "delete") op = { action, deleteTickets: formFlag(form, "deletetickets") };
  else if (action === "setorg") op = { action, orgId: formNum(form, "orgId") };
  else if (["lock", "unlock", "reset", "register"].includes(action)) op = { action: action as "lock" };
  else return { error: "invalid", nonce: nonce() };
  return run(async (ctx) => {
    const r = await massUserAction(ctx, ids, op);
    if (r.error) return { error: r.error, nonce: nonce() };
    if (!r.count) return { error: "none_processed", nonce: nonce() };
    return { ok: true, count: r.count, notice: r.count === ids.length ? "mass_done" : "mass_partial", nonce: nonce() };
  }, ids.map((i) => `/agent/users/${i}`));
}

/** ajax.users.php:importUsers / scp/users.php do=import-users (testo CSV incollato o file) */
export async function userImportAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  let pasted = formStr(form, "pasted");
  const file = form.get("import");
  if (file && typeof file === "object" && "text" in file && (file as File).size > 0) {
    // File caricato: CsvImporter salta il BOM e usa la prima riga come intestazione
    pasted = (await (file as File).text()).replace(/^﻿/, "");
    return run(async (ctx) => importResult(await importUsers(ctx, pasted, {}, { file: true })));
  }
  return run(async (ctx) => importResult(await importUsers(ctx, pasted)));
}

function importResult(r: Awaited<ReturnType<typeof importUsers>>): PeopleActionState {
  if (r.ok) return { ok: true, count: r.count, notice: "imported", nonce: nonce() };
  return { error: r.error, fields: r.detail ? { pasted: r.detail } : undefined, nonce: nonce() };
}
