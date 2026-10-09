"use server";

import { getLocale } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { redirect } from "@/i18n/navigation";
import type { PeopleActionState } from "@/components/people/types";
import { clientIp } from "@/server/auth/session";
import { currentAgent } from "@/server/auth/staff-auth";
import { db } from "@/server/db";
import { defaultFormOf } from "@/server/domain/directory/forms";
import { addOrgUser, createOrg, deleteOrg, massDeleteOrgs, removeOrgUsers, updateOrg, updateOrgProfile } from "@/server/domain/directory/orgs";
import { formSource } from "@/server/domain/directory/ui";
import { importUsers, type DirResult } from "@/server/domain/directory/users";
import { GlobalPerm, type Agent } from "@/server/domain/staff/staff";
import type { WriteContext } from "@/server/domain/ticket/context";
import { runWrite } from "@/server/domain/write";

/** Server action delle organizzazioni (scp/orgs.php, include/ajax.orgs.php). */

const nonce = () => Date.now();

function state(r: DirResult, redirect?: string): PeopleActionState {
  if (r.ok) return { ok: true, redirect, nonce: nonce() };
  return { error: r.error, fields: r.fields, nonce: nonce() };
}

async function run(fn: (ctx: WriteContext, agent: Agent) => Promise<PeopleActionState>, paths: string[] = []): Promise<PeopleActionState> {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired" };
  const r = await runWrite({ agent, ip: await clientIp() }, (ctx) => fn(ctx, agent));
  if (r.ok) for (const p of ["/agent/orgs", "/agent/users", ...paths]) revalidatePath(p);
  return r;
}

async function fieldsOf(form: FormData, type: "U" | "O") {
  const f = await defaultFormOf(db(), type);
  return formSource(form, f?.fields ?? []);
}

const orgId = (form: FormData) => Number(form.get("orgId") ?? 0);

/** ajax.orgs.php:addOrg */
export async function orgCreateAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const input = await fieldsOf(form, "O");
  return run(async (ctx) => {
    const r = await createOrg(ctx, input);
    return r.ok ? { ok: true, redirect: `/agent/orgs/${r.id}`, nonce: nonce() } : state(r);
  });
}

/** ajax.orgs.php:updateOrg (campi del form) */
export async function orgUpdateAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const id = orgId(form);
  const input = await fieldsOf(form, "O");
  return run(async (ctx) => state(await updateOrg(ctx, id, input)), [`/agent/orgs/${id}`]);
}

/** ajax.orgs.php:updateOrg/profile: dominio, account manager, collaboratori automatici, condivisione, contatti */
export async function orgProfileAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const id = orgId(form);
  const input = { name: String(form.get("name") ?? "") };
  const flag = (k: string) => form.get(k) === "1";
  return run(
    async (ctx) =>
      state(
        await updateOrgProfile(ctx, id, input, {
          domain: String(form.get("domain") ?? ""),
          manager: String(form.get("manager") ?? ""),
          "collab-all-flag": flag("collab-all-flag"),
          "collab-pc-flag": flag("collab-pc-flag"),
          "assign-am-flag": flag("assign-am-flag"),
          sharing: String(form.get("sharing") ?? ""),
          contacts: form.getAll("contacts").map((v) => String(v)),
        }),
      ),
    [`/agent/orgs/${id}`],
  );
}

/** ajax.orgs.php:delete */
export async function orgDeleteAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const id = orgId(form);
  const r = await run(async (ctx) => state(await deleteOrg(ctx, id)));
  if (r.ok) redirect({ href: "/agent/orgs", locale: await getLocale() });
  return r;
}

/** scp/orgs.php a=mass_process do=delete */
export async function orgMassDeleteAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const ids = form.getAll("ids").map((v) => Number(v)).filter((n) => n > 0);
  if (!ids.length) return { error: "none_selected", nonce: nonce() };
  return run(async (ctx, agent) => {
    if (!agent.hasGlobalPerm(GlobalPerm.ORG_DELETE)) return { error: "forbidden", nonce: nonce() };
    const r = await massDeleteOrgs(ctx, ids);
    return r.count ? { ok: true, count: r.count, notice: r.count === ids.length ? "mass_done" : "mass_partial", nonce: nonce() } : { error: "none_processed", nonce: nonce() };
  });
}

/** ajax.orgs.php:addUser: utente esistente (id) o nuovo utente dal form */
export async function orgAddUserAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const id = orgId(form);
  const userId = Number(form.get("userId") ?? 0);
  const fields = userId ? undefined : await fieldsOf(form, "U");
  return run(async (ctx) => state(await addOrgUser(ctx, id, { userId: userId || undefined, fields })), [`/agent/orgs/${id}`]);
}

/** scp/orgs.php a=remove-users */
export async function orgRemoveUsersAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const id = orgId(form);
  const ids = form.getAll("ids").map((v) => Number(v)).filter((n) => n > 0);
  if (!ids.length) return { error: "none_selected", nonce: nonce() };
  return run(async (ctx) => {
    const r = await removeOrgUsers(ctx, id, ids);
    return r.count ? { ok: true, count: r.count, nonce: nonce() } : { error: "none_processed", nonce: nonce() };
  }, [`/agent/orgs/${id}`]);
}

/**
 * ajax.orgs.php:importUsers (richiede org.create) / scp/orgs.php a=import-users (nessun controllo nel
 * PHP): qui servono org.create e user.create (regola più stretta).
 */
export async function orgImportAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const id = orgId(form);
  let pasted = String(form.get("pasted") ?? "");
  const file = form.get("import");
  const isFile = !!file && typeof file === "object" && (file as File).size > 0;
  if (isFile) pasted = (await (file as File).text()).replace(/^﻿/, "");
  return run(async (ctx, agent) => {
    if (!agent.hasGlobalPerm(GlobalPerm.ORG_CREATE)) return { error: "forbidden", nonce: nonce() };
    if (!(await ctx.tx.selectFrom("organization").select("id").where("id", "=", id).executeTakeFirst())) return { error: "not_found", nonce: nonce() };
    const r = await importUsers(ctx, pasted, { orgId: id }, { file: isFile });
    if (r.ok) return { ok: true, count: r.count, notice: "imported", nonce: nonce() };
    return { error: r.error, fields: r.detail ? { pasted: r.detail } : undefined, nonce: nonce() };
  }, [`/agent/orgs/${id}`]);
}
