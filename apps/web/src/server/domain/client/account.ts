import "server-only";

import { UserAccountStatus } from "@/lib/osticket/flags";
import { FormType } from "@/lib/osticket/object-types";

import { hashPassword, checkPassword } from "../../auth/passwd";
import { coreConfig, type ConfigNamespace } from "../../config/config";
import { db, type DbOrTx } from "../../db";
import { detectDbTimezone } from "../../db/time";
import { phpLooseEquals, str } from "../../php/values";
import { checkPasswordPolicy, type PasswordError } from "../directory/accounts";
import { FormInstance } from "../forms/entry";
import { isRequiredFor, isVisibleTo, type FieldErrorCode } from "../forms/fields";
import { loadFormDef } from "../forms/load";
import { lookupUserByEmail, userFromVars } from "../ticket/create-user";
import { resetTokenValid } from "./auth-reset";
import { loadClientAccount, lookupAccountByUsername, passwordVersion, type ClientAccountRow, type ClientIdentity } from "./identity";
import { prepareUnlockMail } from "./mails";
import { updateUserInfoForClient } from "./profile-info";
import { canWrite, withWriteScope } from "../../system/write-mode";

/**
 * Account dei clienti dal portale: registrazione (account.php) e profilo (profile.php →
 * ClientAccount::update + User::updateInfo, in profile-info.ts). La richiesta di reset della
 * password (pwreset.php do=sendmail) è in password-reset.ts.
 */

export type AccountFieldError = "required" | "mismatch" | "current_required" | "current_invalid" | "invalid_token" | "registered" | PasswordError | FieldErrorCode | "in_use";

interface AccountErrors {
  /** read_only: scritture non consentite dalla modalità (TAILTICKET_MODE) */
  err?: "incomplete" | "unable" | "disabled" | "profile" | "internal" | "read_only";
  /** errori per campo: passwd1, passwd2, cpasswd, email, name, … o id del campo dinamico */
  fields?: Record<string, AccountFieldError>;
}

export type AccountResult<T = object> = ({ ok: true } & T) | ({ ok: false } & AccountErrors);

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


/** Esito del profilo: nuova versione della password per aggiornare la sessione corrente */
type ProfileResult = AccountResult<{ pwv: string; passwordChanged: boolean }>;

/**
 * profile.php POST: ClientAccount::update (preferenze e password) e, senza errori, User::updateInfo.
 * Gli ospiti (accesso da link) non possono modificare il profilo (presa di controllo dell'account).
 */
export async function updateClientProfile(client: ClientIdentity, vars: ClientAccountVars, resetToken: string | null = null): Promise<ProfileResult> {
  if (client.guest) return { ok: false, err: "unable" };
  if (!(await canWrite("operational"))) return { ok: false, err: "read_only" };
  const cfg = await coreConfig();
  await detectDbTimezone(db());
  return withWriteScope(
    "operational",
    () =>
      db()
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
          return {
            ok: true,
            pwv: passwordVersion(passwd),
            passwordChanged: passwd !== (acct?.passwd ?? null),
          };
        }),
    { op: "client.profile", actor: { type: "client", id: client.id } },
  );
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
  if (!(await canWrite("operational"))) return { ok: false, err: "read_only" };
  await detectDbTimezone(db());
  const input: Record<string, unknown> = { ...vars };
  if (guest) input.email = guest.email;
  let send: (() => Promise<void>) | null = null;
  const res = await withWriteScope(
    "operational",
    () =>
      db()
        .transaction()
        .execute(async (tx): Promise<AccountResult<{ userId: number }>> => {
          const def = await loadFormDef(tx, cfg, { type: FormType.USER }, "client");
          if (!def) return { ok: false, err: "internal" };
          const timezone = cfg.str("default_timezone") || "UTC";
          const inst = new FormInstance(def, input, 1, null, { timezone });
          const errs = await inst.validate(
            (f) => isVisibleTo(f, "client"),
            (f) => isRequiredFor(f, "client"),
            cfg,
          );
          const fields: Record<string, AccountFieldError> = {};
          for (const [id, codes] of Object.entries(errs)) fields[def.fields.find((x) => x.id === Number(id))?.name || id] = codes[0];
          if (Object.keys(fields).length) return { ok: false, err: "incomplete", fields };
          const p1 = str(vars.passwd1);
          if (!p1)
            return {
              ok: false,
              err: "unable",
              fields: { passwd1: "required" },
            };
          if (str(vars.passwd2) !== p1)
            return {
              ok: false,
              err: "unable",
              fields: { passwd1: "mismatch" },
            };
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
            if (!r.ok)
              return {
                ok: false,
                err: "unable",
                fields: r.ok ? undefined : r.fields,
              };
            userId = existing.id;
          } else if (guest) {
            userId = guest.id;
          } else {
            // User::fromForm: validazione di tutti i campi ($thisstaff assente) ed email non in uso
            const all = await inst.validate(
              () => true,
              (f) => isRequiredFor(f, "client"),
              cfg,
            );
            if (Object.keys(all).length) return { ok: false, err: "unable" };
            const u = await userFromVars(tx, cfg, inst.cleanVars(), {
              dates: { cfg, timezone },
            });
            if (!u) return { ok: false, err: "unable" };
            userId = u.id;
          }
          const r = await clientAccountUpdate(tx, cfg, userId, null, vars, null);
          if (!r.ok) return { ok: false, err: "profile", fields: r.fields };
          // do=create: UserAccount::sendConfirmEmail
          send = await prepareUnlockMail(tx, cfg, userId, "registration-client");
          return { ok: true, userId };
        }),
    { op: "client.register" },
  );
  if (res.ok && send) {
    try {
      await (send as () => Promise<void>)();
    } catch (err) {
      console.error("[portal] email di conferma non inviata", err);
    }
  }
  return res;
}
