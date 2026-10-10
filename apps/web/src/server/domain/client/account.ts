import "server-only";

import { UserAccountStatus } from "@/lib/osticket/flags";
import { FormType } from "@/lib/osticket/object-types";

import { hashPassword, checkPassword } from "../../auth/passwd";
import { coreConfig, type ConfigNamespace } from "../../config/config";
import { NOW, db, type DbOrTx } from "../../db";
import { detectDbTimezone } from "../../db/time";
import { phpLooseEquals, str } from "../../php/values";
import { checkPasswordPolicy, type PasswordError } from "../directory/accounts";
import { addMissingAnswers, entriesFor, saveEntryAnswers, createEntry, defaultFormOf, type FormEntry } from "../forms/answers";
import { reindexUser } from "../directory/users";
import { FormInstance } from "../forms/entry";
import { hasAnswerRow, isEditableTo, isRequiredFor, isVisibleTo, type FieldErrorCode } from "../forms/fields";
import { loadFormDef } from "../forms/load";
import { lookupUserByEmail, normalizeUserName, userFromVars } from "../ticket/create-user";
import { resetTokenValid } from "./auth";
import {
  isUserId,
  loadClientAccount,
  lookupAccountByUsername,
  passwordVersion,
  type ClientAccountRow,
  type ClientIdentity,
} from "./identity";
import { prepareUnlockMail } from "./mails";

/**
 * Account dei clienti dal portale: registrazione (account.php), reset password (pwreset.php
 * do=sendmail), profilo (profile.php → ClientAccount::update + User::updateInfo).
 */

export type AccountFieldError =
  | "required"
  | "mismatch"
  | "current_required"
  | "current_invalid"
  | "invalid_token"
  | "registered"
  | PasswordError
  | FieldErrorCode
  | "in_use";

interface AccountErrors {
  err?: "incomplete" | "unable" | "disabled" | "profile" | "internal";
  /** errori per campo: passwd1, passwd2, cpasswd, email, name, … o id del campo dinamico */
  fields?: Record<string, AccountFieldError>;
}

type AccountResult<T = object> = ({ ok: true } & T) | ({ ok: false } & AccountErrors);

/** Variabili del form account/profilo (POST di account.php e profile.php) */
interface ClientAccountVars {
  timezone?: string;
  lang?: string;
  passwd1?: string;
  passwd2?: string;
  cpasswd?: string;
  [field: string]: unknown;
}

/**
 * ClientAccount::update($vars) lato cliente ($thisstaff assente). Con un token di reset in sessione
 * il PHP non verifica né la conferma né le politiche della password e non controlla la scadenza del
 * token (`&&` al posto di `||`): qui il token deve essere valido e non scaduto e la nuova password
 * rispetta conferma e politica (regola più stretta, bug di sicurezza del PHP non replicato).
 * `acct` null = account nuovo (registrazione): INSERT.
 */
async function clientAccountUpdate(
  tx: DbOrTx,
  cfg: ConfigNamespace,
  userId: number,
  acct: ClientAccountRow | null,
  vars: ClientAccountVars,
  resetToken: string | null,
): Promise<{ ok: true; passwd: string | null } | { ok: false; fields: Record<string, AccountFieldError> }> {
  const fields: Record<string, AccountFieldError> = {};
  const p1 = str(vars.passwd1);
  const p2 = str(vars.passwd2);
  const cur = str(vars.cpasswd);
  if (resetToken) {
    if (!(await resetTokenValid(tx, cfg, resetToken, userId))) fields.passwd1 = "invalid_token";
    else if (p1 || p2) {
      if (!p1) fields.passwd1 = "required";
      else if (p1 !== p2) fields.passwd2 = "mismatch";
      else {
        const e = checkPasswordPolicy(p1, null);
        if (e) fields.passwd1 = e;
      }
    }
  } else if (p1 || p2 || cur) {
    if (!p1) fields.passwd1 = "required";
    else if (p1 !== p2) fields.passwd2 = "mismatch";
    else if (acct?.passwd) {
      if (!cur) fields.cpasswd = "current_required";
      else if (!checkPassword(cur, acct.passwd).ok) fields.cpasswd = "current_invalid";
    }
    if (!Object.keys(fields).length) {
      const e = checkPasswordPolicy(p1, cur || null);
      if (e) fields.passwd1 = e;
    }
  }
  if (Object.keys(fields).length) return { ok: false, fields };

  const values: Record<string, unknown> = {
    timezone: vars.timezone === undefined || vars.timezone === "" ? null : String(vars.timezone),
    lang: str(vars.lang) || null,
  };
  let passwd = acct?.passwd ?? null;
  let status = acct?.status ?? 0;
  if (p1) {
    passwd = hashPassword(p1);
    values.passwd = passwd;
    // cancelResetTokens + clearStatus(REQUIRE_PASSWD_RESET)
    await tx.deleteFrom("config").where("namespace", "=", "pwreset").where("value", "=", `c${userId}`).execute();
    status &= ~UserAccountStatus.REQUIRE_PASSWD_RESET;
    values.status = status;
  }
  if (!acct) {
    await tx.insertInto("user_account").values({ user_id: userId, ...values } as never).execute();
  } else {
    // VerySimpleModel::save: solo i campi modificati (confronto debole)
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      const old = acct[k as keyof ClientAccountRow];
      if (k === "passwd" ? v !== old : !phpLooseEquals(old, v)) set[k] = v;
    }
    if (Object.keys(set).length) await tx.updateTable("user_account").set(set as never).where("id", "=", acct.id).execute();
  }
  return { ok: true, passwd };
}

/** Campo modificabile dal cliente (DynamicFormField::isEditableToUsers) */
const clientEditable = (f: Parameters<typeof isEditableTo>[0]) => isEditableTo(f, "client");

/** $cfg->getTimezone() per il cliente: fuso dell'account, altrimenti quello predefinito. */
async function clientTimezone(tx: DbOrTx, cfg: ConfigNamespace, userId: number): Promise<string> {
  const a = await tx.selectFrom("user_account").select("timezone").where("user_id", "=", userId).executeTakeFirst();
  return a?.timezone || cfg.str("default_timezone") || "UTC";
}

/** User::getDynamicData($create): entry del form utente, creata vuota se manca */
async function userEntries(tx: DbOrTx, userId: number): Promise<FormEntry[]> {
  const entries = await entriesFor(tx, "U", userId);
  if (entries.length) return entries;
  const form = await defaultFormOf(tx, "U");
  if (!form) return [];
  await createEntry(tx, form, "U", "U", userId, {});
  return entriesFor(tx, "U", userId);
}

/**
 * User::updateInfo($vars, $errors, $staff=false): validazione isValidForClient(true) dei campi
 * modificabili dai clienti, email non assegnata ad altri, nome ed email predefinita, risposte del
 * form, poi User::save (nome normalizzato, updated, indice).
 */
async function updateUserInfoForClient(tx: DbOrTx, cfg: ConfigNamespace, userId: number, input: Record<string, unknown>): Promise<AccountResult> {
  const user = await tx.selectFrom("user").select(["id", "name", "default_email_id"]).where("id", "=", userId).forUpdate().executeTakeFirst();
  if (!user) return { ok: false, err: "unable" };
  const entries = await userEntries(tx, userId);
  const timezone = await clientTimezone(tx, cfg, userId);
  // User::getForms: addMissingFields prima della validazione
  for (const e of entries) await addMissingAnswers(tx, e, userId);
  const fields: Record<string, AccountFieldError> = {};
  for (const e of entries) {
    const def = await loadFormDef(tx, cfg, { id: e.form_id }, "client");
    if (!def) continue;
    const inst = new FormInstance(def, input, 1, null, { timezone });
    const errs = await inst.validate((f) => isEditableTo(f, "client"), (f) => isRequiredFor(f, "client"), cfg);
    for (const [id, codes] of Object.entries(errs)) {
      const f = def.fields.find((x) => x.id === Number(id));
      fields[f?.name || id] = codes[0];
    }
    if (!Object.keys(errs).length && e.form_type === FormType.USER) {
      const ef = def.fields.find((x) => x.name === "email");
      const email = ef ? inst.get("email") : null;
      if (ef && isEditableTo(ef, "client") && typeof email === "string" && email) {
        const other = await lookupUserByEmail(tx, email);
        if (other && other.id !== userId) fields.email = "in_use";
      }
    }
  }
  if (Object.keys(fields).length) return { ok: false, err: "profile", fields };

  let name: string | undefined;
  let touch = false;
  for (const e of entries) {
    if (e.form_type === FormType.USER) {
      const def = await loadFormDef(tx, cfg, { id: e.form_id }, "client");
      const inst = def ? new FormInstance(def, input, 1, null, { timezone }) : null;
      const nf = e.fields.find((x) => x.name === "name");
      if (inst && nf && clientEditable(nf) && input.name !== undefined) {
        const v = inst.get("name");
        name = (typeof v === "object" && v ? Object.values(v).join(", ") : str(v)).trim();
      }
      const ef = e.fields.find((x) => x.name === "email");
      if (inst && ef && clientEditable(ef) && input.email !== undefined) {
        const email = str(inst.get("email"));
        const cur = await tx.selectFrom("user_email").select(["id", "address"]).where("id", "=", user.default_email_id).executeTakeFirst();
        if (cur && cur.address !== email) await tx.updateTable("user_email").set({ address: email }).where("id", "=", cur.id).execute();
      }
    }
    const r = await saveEntryAnswers(tx, e, userId, input, { isEditable: (f) => clientEditable(f) && hasAnswerRow(f), onlyProvided: true, timezone });
    if (r.dirty) touch = true;
  }
  // User::save: nome "sporco" se diverso dal valore attuale (prima della normalizzazione)
  const set: Record<string, unknown> = {};
  if (name !== undefined && !phpLooseEquals(user.name, name)) set.name = normalizeUserName(name);
  if (Object.keys(set).length || touch) {
    set.updated = NOW;
    await tx.updateTable("user").set(set as never).where("id", "=", userId).execute();
    await reindexUser(tx, userId, undefined, { cfg, timezone });
  }
  return { ok: true };
}

/** Esito del profilo: nuova versione della password per aggiornare la sessione corrente */
type ProfileResult = AccountResult<{ pwv: string; passwordChanged: boolean }>;

/**
 * profile.php POST: ClientAccount::update (preferenze e password) e, senza errori, User::updateInfo.
 * Gli ospiti (accesso da link) non possono modificare il profilo (presa di controllo dell'account).
 */
export async function updateClientProfile(client: ClientIdentity, vars: ClientAccountVars, resetToken: string | null = null): Promise<ProfileResult> {
  if (client.guest) return { ok: false, err: "unable" };
  const cfg = await coreConfig();
  await detectDbTimezone(db());
  return db()
    .transaction()
    .execute(async (tx): Promise<ProfileResult> => {
      const acct = await loadClientAccount(tx, client.id, true);
      let passwd = acct?.passwd ?? null;
      if (acct) {
        const r = await clientAccountUpdate(tx, cfg, client.id, acct, vars, resetToken);
        if (!r.ok) return { ok: false, err: "profile", fields: r.fields };
        passwd = r.passwd;
      }
      const info = await updateUserInfoForClient(tx, cfg, client.id, vars);
      if (!info.ok) return info;
      return { ok: true, pwv: passwordVersion(passwd), passwordChanged: passwd !== (acct?.passwd ?? null) };
    });
}

/**
 * account.php POST do=create: registrazione di un account dal portale (client_registration public/auto).
 * Utente nuovo: User::fromForm (utente, email, form utente, indice); utente esistente senza account:
 * User::updateInfo come il PHP; poi ClientAccount::update (password, fuso) e email di conferma
 * "registration-client" con il token in config "pwreset". Un ospite (accesso da link) registra il
 * proprio utente con l'email già nota.
 */
export async function registerClientAccount(vars: ClientAccountVars, guest: ClientIdentity | null = null): Promise<AccountResult<{ userId: number }>> {
  const cfg = await coreConfig();
  if (!["public", "auto"].includes(cfg.str("client_registration"))) return { ok: false, err: "disabled" };
  await detectDbTimezone(db());
  const input: Record<string, unknown> = { ...vars };
  if (guest) input.email = guest.email;
  let send: (() => Promise<void>) | null = null;
  const res = await db()
    .transaction()
    .execute(async (tx): Promise<AccountResult<{ userId: number }>> => {
      const def = await loadFormDef(tx, cfg, { type: FormType.USER }, "client");
      if (!def) return { ok: false, err: "internal" };
      const timezone = cfg.str("default_timezone") || "UTC";
      const inst = new FormInstance(def, input, 1, null, { timezone });
      const errs = await inst.validate((f) => isVisibleTo(f, "client"), (f) => isRequiredFor(f, "client"), cfg);
      const fields: Record<string, AccountFieldError> = {};
      for (const [id, codes] of Object.entries(errs)) fields[def.fields.find((x) => x.id === Number(id))?.name || id] = codes[0];
      if (Object.keys(fields).length) return { ok: false, err: "incomplete", fields };
      const p1 = str(vars.passwd1);
      if (!p1) return { ok: false, err: "unable", fields: { passwd1: "required" } };
      if (str(vars.passwd2) !== p1) return { ok: false, err: "unable", fields: { passwd1: "mismatch" } };
      const policy = checkPasswordPolicy(p1, null);
      if (policy) return { ok: false, err: "unable", fields: { passwd1: policy } };

      const addr = str(inst.get("email"));
      if (addr && (await lookupAccountByUsername(tx, addr))) return { ok: false, err: "unable", fields: { email: "registered" } };
      if (!addr) return { ok: false, fields: { email: "required" } };
      const nameV = inst.get("name");
      if (!nameV) return { ok: false, fields: { name: "required" } };

      let userId: number;
      const existing = await lookupUserByEmail(tx, addr);
      if (existing) {
        const r = await updateUserInfoForClient(tx, cfg, existing.id, input);
        if (!r.ok) return { ok: false, err: "unable", fields: r.ok ? undefined : r.fields };
        userId = existing.id;
      } else if (guest) {
        userId = guest.id;
      } else {
        // User::fromForm: validazione di tutti i campi ($thisstaff assente) ed email non in uso
        const all = await inst.validate(() => true, (f) => isRequiredFor(f, "client"), cfg);
        if (Object.keys(all).length) return { ok: false, err: "unable" };
        const u = await userFromVars(tx, cfg, inst.cleanVars(), { dates: { cfg, timezone } });
        if (!u) return { ok: false, err: "unable" };
        userId = u.id;
      }
      const r = await clientAccountUpdate(tx, cfg, userId, null, vars, null);
      if (!r.ok) return { ok: false, err: "profile", fields: r.fields };
      // do=create: UserAccount::sendConfirmEmail
      send = await prepareUnlockMail(tx, cfg, userId, "registration-client");
      return { ok: true, userId };
    });
  if (res.ok && send) {
    try {
      await (send as () => Promise<void>)();
    } catch (err) {
      console.error("[portal] email di conferma non inviata", err);
    }
  }
  return res;
}

type ResetRequestResult = { ok: true } | { ok: false; error: "disabled" | "unavailable" | "failed" };

/**
 * pwreset.php POST do=sendmail: nessuna informazione sull'esistenza dell'account (stessa risposta),
 * tempo minimo di risposta di 1,4 s più un ritardo casuale, come il PHP.
 */
export async function requestClientPasswordReset(userid: string, opts: { pad?: boolean } = {}): Promise<ResetRequestResult> {
  const start = Date.now();
  const cfg = await coreConfig();
  await detectDbTimezone(db());
  let out: ResetRequestResult = { ok: true };
  let send: (() => Promise<void>) | null = null;
  const id = userid.trim();
  if (isUserId(id)) {
    await db()
      .transaction()
      .execute(async (tx) => {
        const acct = await lookupAccountByUsername(tx, id);
        if (!acct) return;
        if (acct.status & UserAccountStatus.FORBID_PASSWD_RESET) out = { ok: false, error: "disabled" };
        else if (!acct.passwd || (acct.backend && acct.backend !== "client")) out = { ok: false, error: "unavailable" };
        else {
          send = await prepareUnlockMail(tx, cfg, acct.user_id, "pwreset-client");
          if (!send) out = { ok: false, error: "failed" };
        }
      });
  }
  if (send) {
    try {
      await (send as () => Promise<void>)();
    } catch (err) {
      console.error("[portal] email di reset non inviata", err);
    }
  }
  if (opts.pad !== false) {
    const target = 1400 + Math.floor(Math.random() * 251);
    const elapsed = Date.now() - start;
    if (elapsed < target) await new Promise((r) => setTimeout(r, target - elapsed));
  }
  return out;
}
