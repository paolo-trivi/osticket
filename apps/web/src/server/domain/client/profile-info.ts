import "server-only";

import { FormType } from "@/lib/osticket/object-types";

import type { ConfigNamespace } from "../../config/config";
import { NOW, type DbOrTx } from "../../db";
import { phpLooseEquals, str } from "../../php/values";
import { addMissingAnswers, saveEntryAnswers } from "../forms/answers";
import { reindexUser, userEntries } from "../directory/users";
import { FormInstance } from "../forms/entry";
import { hasAnswerRow, isEditableTo, isRequiredFor } from "../forms/fields";
import { loadFormDef } from "../forms/load";
import { lookupUserByEmail, normalizeUserName } from "../ticket/create-user";
import type { AccountFieldError, AccountResult } from "./account";

/** Dati dell'utente modificati dal portale: User::updateInfo($vars, $errors, $staff=false). */

/** Campo modificabile dal cliente (DynamicFormField::isEditableToUsers) */
const clientEditable = (f: Parameters<typeof isEditableTo>[0]) => isEditableTo(f, "client");

/** $cfg->getTimezone() per il cliente: fuso dell'account, altrimenti quello predefinito. */
async function clientTimezone(tx: DbOrTx, cfg: ConfigNamespace, userId: number): Promise<string> {
  const a = await tx.selectFrom("user_account").select("timezone").where("user_id", "=", userId).executeTakeFirst();
  return a?.timezone || cfg.str("default_timezone") || "UTC";
}

/**
 * User::updateInfo($vars, $errors, $staff=false): validazione isValidForClient(true) dei campi
 * modificabili dai clienti, email non assegnata ad altri, nome ed email predefinita, risposte del
 * form, poi User::save (nome normalizzato, updated, indice).
 */
export async function updateUserInfoForClient(tx: DbOrTx, cfg: ConfigNamespace, userId: number, input: Record<string, unknown>): Promise<AccountResult> {
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
