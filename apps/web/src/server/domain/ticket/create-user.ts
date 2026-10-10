import "server-only";

import { FormType } from "@/lib/osticket/object-types";

import type { ConfigNamespace } from "../../config/config";
import { NOW, type DbOrTx } from "../../db";
import { likeEscape } from "../../db/like";
import { htmlDecode } from "../../format/html";
import { sanitizeText, searchable } from "../../format/text";
import { intval, isArray, isset, list, str, truthy, type PhpVal, type PhpVars } from "../../php/values";
import { replaceSearchRow } from "../search/index-writer";
import { FormInstance, saveFormEntry } from "../forms/entry";
import type { DateFormatOptions } from "../forms/fields";
import { loadFormDef } from "../forms/load";
import { isEmail } from "../forms/validator";

/**
 * Utenti finali per la creazione dei ticket (include/class.user.php): ricerca per email,
 * User::fromVars (utente + user_email + form "Contact Information" + user__cdata + indice) e
 * organizzazione per dominio (Organization::forDomain).
 */

export interface UserRow {
  id: number;
  org_id: number;
  default_email_id: number;
  status: number;
  name: string;
}

/** User::lookupByEmail */
export async function lookupUserByEmail(executor: DbOrTx, email: string): Promise<UserRow | null> {
  if (!email) return null;
  const r = await executor
    .selectFrom("user as u")
    .innerJoin("user_email as e", "e.user_id", "u.id")
    .select(["u.id", "u.org_id", "u.default_email_id", "u.status", "u.name"])
    .where("e.address", "=", email)
    .executeTakeFirst();
  return r ?? null;
}

export async function lookupUser(executor: DbOrTx, id: number): Promise<UserRow | null> {
  if (!id) return null;
  const r = await executor.selectFrom("user").select(["id", "org_id", "default_email_id", "status", "name"]).where("id", "=", id).executeTakeFirst();
  return r ?? null;
}

export async function userEmail(executor: DbOrTx, user: UserRow): Promise<string> {
  const e = await executor.selectFrom("user_email").select("address").where("id", "=", user.default_email_id).executeTakeFirst();
  return e?.address ?? "";
}

interface OrgRow {
  id: number;
  name: string;
  manager: string;
  status: number;
  domain: string;
}

export async function loadOrganization(executor: DbOrTx, id: number): Promise<OrgRow | null> {
  if (!id) return null;
  const r = await executor.selectFrom("organization").select(["id", "name", "manager", "status", "domain"]).where("id", "=", id).executeTakeFirst();
  return r ? { ...r, manager: r.manager ?? "", domain: r.domain ?? "" } : null;
}

/** Organization::isMappedToDomain */
function mappedToDomain(orgDomain: string, domain: string): boolean {
  if (!domain || !orgDomain) return false;
  for (const raw of orgDomain.split(",")) {
    const d = raw.trim();
    if (d.startsWith(".")) {
      if (domain.slice(-d.length).toLowerCase() === d.toLowerCase()) return true;
    } else if (domain.toLowerCase() === d.toLowerCase()) return true;
  }
  return false;
}

/** Organization::forDomain */
export async function organizationForDomain(executor: DbOrTx, domain: string): Promise<OrgRow | null> {
  if (!domain) return null;
  const rows = await executor
    .selectFrom("organization")
    .select(["id", "name", "manager", "status", "domain"])
    .where("domain", ">", "")
    .where("domain", "like", `%${likeEscape(domain)}%`)
    .orderBy("name")
    .execute();
  for (const r of rows) if (mappedToDomain(r.domain ?? "", domain)) return { ...r, manager: r.manager ?? "", domain: r.domain ?? "" };
  return null;
}

/** User::save: riordino di "Cognome, Nome" e nomi che sono indirizzi email */
export function normalizeUserName(name: string): string {
  const parts = name.split(",").map((p) => p.trim());
  let out = name;
  if (parts.length === 2) out = `${parts[1]} ${parts[0]}`;
  else if (parts.length === 3) out = `${parts[1]} ${parts[0]} ${parts[2]}`;
  if (isEmail(out)) {
    const box = out.split("@")[0];
    out = (box.includes(".") ? box.replace(/\./g, " ") : box).replace(/\S+/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  }
  return out;
}

/**
 * User::fromVars($vars, $create=true): se l'email non esiste crea utente, email predefinita (UserEmail::ensure),
 * organizzazione (`org_id` se impostato, altrimenti per dominio), entry del form utente e indice.
 * `vars` è il getClean() del form utente (per id e per nome, FormInstance::cleanVars) o i valori già
 * convertiti dell'import CSV: addDynamicData li rilegge con i widget come sorgente della nuova entry.
 * Unica implementazione per creazione dei ticket, portale, directory e import.
 */
export async function userFromVars(
  executor: DbOrTx,
  cfg: ConfigNamespace,
  vars: Record<string, unknown>,
  opts: { create?: boolean; dates?: DateFormatOptions } = {},
): Promise<UserRow | null> {
  const email = str(vars.email as PhpVal);
  const existing = await lookupUserByEmail(executor, email);
  if (existing || opts.create === false || !isEmail(email)) return existing;

  let name = isArray(vars.name as PhpVal) ? list(vars.name as PhpVal).map(str).join(", ") : str(vars.name as PhpVal);
  if (!truthy(name)) name = email.split("@")[0];
  name = normalizeUserName(htmlDecode(sanitizeText(name)).trim());

  // UserEmail::ensure
  let emailRow = await executor.selectFrom("user_email").select(["id", "user_id"]).where("address", "=", email).executeTakeFirst();
  if (!emailRow) {
    const r = await executor.insertInto("user_email").values({ user_id: 0, flags: 0, address: email }).executeTakeFirstOrThrow();
    emailRow = { id: Number(r.insertId), user_id: 0 };
  }

  let orgId = 0;
  if (isset(vars as PhpVars, "org_id")) orgId = intval(vars.org_id as PhpVal);
  else {
    const org = await organizationForDomain(executor, email.split("@")[1] ?? "");
    if (org) orgId = org.id;
  }

  const res = await executor
    .insertInto("user")
    .values({ org_id: orgId, default_email_id: emailRow.id, status: 0, name, created: NOW, updated: NOW })
    .executeTakeFirstOrThrow();
  const userId = Number(res.insertId);
  await executor.updateTable("user_email").set({ user_id: userId }).where("id", "=", emailRow.id).execute();

  // addDynamicData: form "Contact Information" con la sorgente ricevuta
  const form = await loadFormDef(executor, cfg, { type: FormType.USER });
  let content = "";
  if (form) {
    const inst = new FormInstance(form, vars, 1, null, { dates: opts.dates });
    await saveFormEntry(executor, inst, "U", userId);
    content = inst.searchables(["subject"]).join("\n").trim();
  }
  // user.created → indice: risposte + email (la relazione emails contiene due volte l'indirizzo appena aggiunto)
  await replaceSearchRow(executor, "U", userId, `${content} ${[email, email].join("\n")}`, searchable(name));

  return { id: userId, org_id: orgId, default_email_id: emailRow.id, status: 0, name };
}
