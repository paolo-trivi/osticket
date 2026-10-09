"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import {
  userAccountAction,
  userDeleteAction,
  userMassAction,
  userOrgAction,
  userRegisterAction,
  userSendMailAction,
  userUpdateAction,
} from "@/app/[locale]/(staff)/agent/(panel)/users/actions";
import Button from "@/components/ui/button/Button";

import { CheckField, DynamicField, SelectField, TextField } from "../FormControls";
import PeopleDialog from "../PeopleDialog";
import type { Choice, DynField } from "../types";

export interface UserActionsData {
  userId: number;
  name: string;
  orgId: number;
  orgName: string | null;
  tickets: number;
  fields: DynField[];
  account: null | { status: number; username: string; timezone: string };
  orgs: Choice[];
  timezones: string[];
  can: { edit: boolean; delete: boolean; manage: boolean; createOrg: boolean };
}

type Kind = "edit" | "org" | "register" | "account" | "confirm" | "reset" | "lock" | "unlock" | "delete";

const LOCKED = 0x0002;
const CONFIRMED = 0x0001;

/** Azioni sulla scheda utente (user-view.inc.php / ajax.users.php). */
export default function UserActions({ data }: { data: UserActionsData }) {
  const t = useTranslations("peopleDir");
  const [open, setOpen] = useState<Kind | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const hidden = { userId: data.userId };
  const acct = data.account;
  const buttons: { kind: Kind; show: boolean }[] = [
    { kind: "edit", show: data.can.edit },
    { kind: "org", show: data.can.edit },
    { kind: "register", show: data.can.manage && !acct },
    { kind: "account", show: data.can.manage && !!acct },
    { kind: "confirm", show: data.can.manage && !!acct && !(acct.status & CONFIRMED) },
    { kind: "reset", show: data.can.manage && !!acct },
    { kind: "lock", show: data.can.manage && !!acct && !(acct.status & LOCKED) },
    { kind: "unlock", show: data.can.manage && !!acct && !!(acct.status & LOCKED) },
    { kind: "delete", show: data.can.delete },
  ];
  const tzOptions = data.timezones.map((z) => ({ id: z, name: z }));

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {buttons
          .filter((b) => b.show)
          .map((b) => (
            <Button key={b.kind} size="sm" variant="outline" onClick={() => setOpen(b.kind)} className={b.kind === "delete" ? "text-error-600 dark:text-error-400" : ""}>
              {t(`actions.${b.kind}`)}
            </Button>
          ))}
      </div>

      {open === "edit" && (
        <PeopleDialog title={t("dialogs.edit", { name: data.name })} action={userUpdateAction} submitLabel={t("save")} onClose={close} hidden={hidden} wide>
          {(s) => (
            <div className="space-y-4">
              {data.fields.map((f) => (
                <DynamicField key={f.id} field={f} error={s.fields?.[f.name || String(f.id)]} />
              ))}
            </div>
          )}
        </PeopleDialog>
      )}
      {open === "org" && (
        <PeopleDialog title={t("dialogs.org", { name: data.name })} action={userOrgAction} submitLabel={t("save")} onClose={close} hidden={hidden} notice={data.orgId ? t("changeOrgWarning") : undefined}>
          {(s) => (
            <div className="space-y-4">
              <SelectField name="orgId" label={t("organization")} placeholder={data.can.createOrg ? t("newOrg") : t("selectOrg")} defaultValue={data.orgId || ""} options={data.orgs} error={s.fields?.orgId} />
              {data.can.createOrg && <TextField name="orgName" label={t("newOrgName")} hint={t("newOrgHint")} error={s.fields?.name} />}
            </div>
          )}
        </PeopleDialog>
      )}
      {open === "register" && (
        <PeopleDialog title={t("dialogs.register", { name: data.name })} action={userRegisterAction} submitLabel={t("actions.register")} onClose={close} hidden={hidden}>
          {(s) => (
            <div className="space-y-4">
              <TextField name="username" label={t("username")} hint={t("usernameHint")} error={s.fields?.username} />
              <SelectField name="timezone" label={t("timezone")} placeholder={t("systemDefault")} options={tzOptions} />
              <CheckField name="sendemail" label={t("sendActivation")} defaultChecked />
              <p className="text-theme-xs text-gray-500 dark:text-gray-400">{t("tempPasswordHint")}</p>
              <TextField name="passwd1" type="password" label={t("tempPassword")} autoComplete="new-password" error={s.fields?.passwd1} />
              <TextField name="passwd2" type="password" label={t("confirmPassword")} autoComplete="new-password" error={s.fields?.passwd2} />
              <CheckField name="pwreset-flag" label={t("requirePwReset")} />
              <CheckField name="forbid-pwreset-flag" label={t("forbidPwChange")} />
            </div>
          )}
        </PeopleDialog>
      )}
      {open === "account" && acct && (
        <PeopleDialog title={t("dialogs.account", { name: data.name })} action={userAccountAction} submitLabel={t("save")} onClose={close} hidden={hidden}>
          {(s) => (
            <div className="space-y-4">
              <TextField name="username" label={t("username")} defaultValue={acct.username} error={s.fields?.username} />
              <SelectField name="timezone" label={t("timezone")} placeholder={t("systemDefault")} defaultValue={acct.timezone} options={tzOptions} />
              <TextField name="passwd1" type="password" label={t("newPassword")} autoComplete="new-password" error={s.fields?.passwd1} />
              <TextField name="passwd2" type="password" label={t("confirmPassword")} autoComplete="new-password" error={s.fields?.passwd2} />
              <CheckField name="locked-flag" label={t("lockedFlag")} defaultChecked={!!(acct.status & LOCKED)} />
              <CheckField name="pwreset-flag" label={t("requirePwReset")} defaultChecked={!!(acct.status & 0x0004)} />
              <CheckField name="forbid-pwchange-flag" label={t("forbidPwChange")} defaultChecked={!!(acct.status & 0x0008)} />
            </div>
          )}
        </PeopleDialog>
      )}
      {(open === "confirm" || open === "reset") && (
        <PeopleDialog title={t(`dialogs.${open}`, { name: data.name })} action={userSendMailAction} submitLabel={t("send")} onClose={close} hidden={{ ...hidden, kind: open }} notice={t(`${open}Notice`)} />
      )}
      {(open === "lock" || open === "unlock") && (
        <PeopleDialog title={t(`dialogs.${open}`, { name: data.name })} action={userMassAction} submitLabel={t(`actions.${open}`)} onClose={close} hidden={{ ids: data.userId, do: open }} notice={t(`${open}Notice`)} />
      )}
      {open === "delete" && (
        <PeopleDialog title={t("dialogs.delete", { name: data.name })} action={userDeleteAction} submitLabel={t("actions.delete")} onClose={close} hidden={hidden} danger notice={data.tickets ? t("deleteWithTickets", { n: data.tickets }) : t("deleteConfirm")}>
          {data.tickets > 0 && <CheckField name="deletetickets" label={t("deleteTickets")} />}
        </PeopleDialog>
      )}
    </>
  );
}
