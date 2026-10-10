import "server-only";

import { Dept } from "@/lib/osticket/flags";
import { FormType } from "@/lib/osticket/object-types";

import type { DbOrTx } from "../../db";
import { actionEventData, applyFilterActions } from "../filter/ticket-filter-actions";
import { filterInput, loadActiveFilters, originToTarget, prepareSupportedMatches, TicketRejected, type FilterAction, type TicketVars } from "../filter/ticket-filter";
import { FormInstance } from "../forms/entry";
import { cleanFromDb, fieldToString, type DateFormatOptions } from "../forms/fields";
import { loadFormDef } from "../forms/load";
import { isEmailBanned } from "./collab";
import type { WriteContext } from "./context";
import type { CreateOrigin } from "./create";
import { sendFilterEmail } from "./create-alerts";
import { topicIsActive } from "./create-topic";
import { loadOrganization, lookupUserByEmail, organizationForDomain, userEmail, type UserRow } from "./create-user";
import { logTicketEvent } from "./events";
import type { TicketRecord } from "./record";

/**
 * Filtri dei ticket in creazione (Ticket::filterTicketData, include/class.ticket.php): dati confrontabili
 * dei form e dell'utente/organizzazione, ban list di sistema e azioni dei filtri attivi.
 */

async function deptIsActive(executor: DbOrTx, id: number): Promise<boolean> {
  const d = await executor.selectFrom("department").select("flags").where("id", "=", id).executeTakeFirst();
  return !!d && (d.flags & Dept.ACTIVE) !== 0;
}

/** Risposte salvate di un oggetto (utente/organizzazione) come dati per i filtri: field.<id> → testo */
async function entryFilterData(
  ctx: WriteContext,
  objectType: "U" | "O",
  objectId: number,
  special: Record<string, string>,
  dates: DateFormatOptions,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = await ctx.tx.selectFrom("form_entry").select(["id", "form_id"]).where("object_type", "=", objectType).where("object_id", "=", objectId).orderBy("sort").orderBy("id").execute();
  for (const e of entries) {
    const def = await loadFormDef(ctx.tx, ctx.cfg, { id: e.form_id });
    if (!def) continue;
    const values = await ctx.tx.selectFrom("form_entry_values").select(["field_id", "value", "value_id"]).where("entry_id", "=", e.id).execute();
    const local: Record<string, string> = {};
    for (const v of values) {
      const f = def.fields.find((x) => x.id === v.field_id);
      if (!f) continue;
      const s = fieldToString(f, cleanFromDb(f, v.value, v.value_id), dates);
      if (s) local[`field.${f.id}`] = s;
    }
    if (def.type === objectType) {
      for (const [name, val] of Object.entries(special)) {
        const f = def.fields.find((x) => x.name === name);
        if (f) local[`field.${f.id}`] = val;
      }
    }
    for (const [k, v] of Object.entries(local)) if (!(k in out)) out[k] = v;
  }
  return out;
}

const addMissing = (vars: TicketVars, data: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(data)) if (!(k in vars)) vars[k] = v;
};

/**
 * Ticket::filterTicketData: dati dei form e dell'utente/organizzazione, banlist, filtri.
 * Prima della creazione può lanciare TicketRejected; dopo la creazione registra gli eventi "edited".
 */
export async function filterTicketData(
  ctx: WriteContext,
  origin: CreateOrigin,
  input: TicketVars,
  forms: FormInstance[],
  user: UserRow | null,
  post: { rec: TicketRecord; threadId: number } | null,
  dates: DateFormatOptions,
): Promise<TicketVars> {
  const vars: TicketVars = {};
  for (const [k, v] of Object.entries(input)) if (!k.startsWith("field.")) vars[k] = v;
  for (const F of forms) addMissing(vars, { ...F.filterData(), ...(await F.listFilterData(ctx.tx)) });

  let userForm: FormInstance | null = null;
  if (!user) {
    const def = await loadFormDef(ctx.tx, ctx.cfg, { type: FormType.USER });
    if (def) {
      userForm = new FormInstance(def, vars, 1, null, { dates });
      for (const n of ["name", "email"]) {
        const f = userForm.field(n);
        if (f) vars[n] = fieldToString(f, userForm.values.get(f.id) ?? null, dates);
      }
    }
    user = await lookupUserByEmail(ctx.tx, String(vars.email ?? ""));
  }
  if (user) {
    const email = await userEmail(ctx.tx, user);
    addMissing(vars, await entryFilterData(ctx, "U", user.id, { name: user.name, email }, dates));
    vars.email = email;
    vars.name = user.name;
    const org = await loadOrganization(ctx.tx, user.org_id);
    if (org) addMissing(vars, await entryFilterData(ctx, "O", org.id, { name: org.name }, dates));
  } else {
    if (userForm) for (const f of userForm.fields) vars[`field.${f.id}`] = fieldToString(f, userForm.values.get(f.id) ?? null, dates);
    const domain = String(vars.email ?? "").split("@")[1] ?? "";
    const org = await organizationForDomain(ctx.tx, domain);
    if (org) addMissing(vars, await entryFilterData(ctx, "O", org.id, { name: org.name }, dates));
  }

  if (await isEmailBanned(ctx.tx, String(vars.email ?? ""))) throw new TicketRejected("SYSTEM BAN LIST", String(vars.email ?? ""));

  await prepareSupportedMatches(ctx.tx);
  const filters = await loadActiveFilters(ctx.tx, originToTarget(origin), Number(vars.emailId ?? 0));
  const checks = { isActive: (id: number) => deptIsActive(ctx.tx, id), topicIsActive: (id: number) => topicIsActive(ctx.tx, id) };
  const submitter = { name: String(vars.name ?? ""), email: String(vars.email ?? "") };
  const sendEmail = post ? (a: FilterAction) => sendFilterEmail(ctx, post.rec.id, a.config, submitter) : undefined;
  const applied = await applyFilterActions(filters, filterInput(vars), vars, !!post, checks, sendEmail);
  if (post) {
    for (const f of applied) {
      for (const a of f.actions) {
        const data = await actionEventData(ctx.tx, a, f.name);
        if (data) await logTicketEvent(ctx.tx, post.rec.row, post.threadId, ctx.actor, "edited", data, "Ticket Filter");
      }
    }
  }
  return vars;
}
