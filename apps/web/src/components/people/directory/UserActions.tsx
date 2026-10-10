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
import ActionNotice from "@/components/common/ActionNotice";
import { useReadOnlyHint } from "@/components/common/WriteGate";
import Button from "@/components/ui/button/Button";
import { UserAccountStatus } from "@/lib/osticket/flags";

import { CheckField, DynamicField, SelectField, TextField } from "../FormControls";
import PeopleDialog from "../PeopleDialog";
import type { Choice, DynField } from "../types";
import { useActionNotice } from "../useActionNotice";

interface UserActionsData {
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

/**
 * Azioni sulla scheda utente (user-view.inc.php / ajax.users.php). Dopo un'azione riuscita la scheda si
 * ricarica e mostra l'esito; l'eliminazione torna alla lista, che mostra l'esito.
 */
export default function UserActions({ data }: { data: UserActionsData }) {
  const t = useTranslations("peopleDir");
  const tu = useTranslations("peopleUi");
  const [open, setOpen] = useState<Kind | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const { notice, clear, withNotice } = useActionNotice();
  const done = (code: string) => () => tu(`done.${code}`);
  // sola lettura: pulsanti disattivati con il motivo nel tooltip
  const readOnly = useReadOnlyHint();
  const hidden = { userId: data.userId };
  const acct = data.account;
  const buttons: { kind: Kind; show: boolean }[] = [
    { kind: "edit", show: data.can.edit },
    { kind: "org", show: data.can.edit },
    { kind: "register", show: data.can.manage && !acct },
    { kind: "account", show: data.can.manage && !!acct },
    { kind: "confirm", show: data.can.manage && !!acct && !(acct.status & UserAccountStatus.CONFIRMED) },
    { kind: "reset", show: data.can.manage && !!acct },
    { kind: "lock", show: data.can.manage && !!acct && !(acct.status & UserAccountStatus.LOCKED) },
    { kind: "unlock", show: data.can.manage && !!acct && !!(acct.status & UserAccountStatus.LOCKED) },
    { kind: "delete", show: data.can.delete },
  ];
  const tzOptions = data.timezones.map((z) => ({ id: z, name: z }));

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {buttons
          .filter((b) => b.show)
          .map((b) => (
            <Button
              key={b.kind}
              size="sm"
              variant="outline"
              onClick={() => setOpen(b.kind)}
              disabled={!!readOnly}
              title={readOnly}
              className={b.kind === "delete" ? "text-error-600 dark:text-error-400" : ""}
            >
              {t(`actions.${b.kind}`)}
            </Button>
          ))}
        {notice && (
          <ActionNotice closeLabel={tu("dismiss")} onClose={clear}>
            {notice}
          </ActionNotice>
        )}
      </div>

      {open === "edit" && (
        <PeopleDialog title={t("dialogs.edit", { name: data.name })} action={withNotice(userUpdateAction, done("user_updated"))} submitLabel={t("save")} onClose={close} hidden={hidden} wide>
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
        <PeopleDialog
          title={t("dialogs.org", { name: data.name })}
          action={withNotice(userOrgAction, done("user_org"))}
          submitLabel={t("save")}
          onClose={close}
          hidden={hidden}
          notice={data.orgId ? t("changeOrgWarning") : undefined}
        >
          {(s) => (
            <div className="space-y-4">
              <SelectField name="orgId" label={t("organization")} placeholder={data.can.createOrg ? t("newOrg") : t("selectOrg")} defaultValue={data.orgId || ""} options={data.orgs} error={s.fields?.orgId} />
              {data.can.createOrg && <TextField name="orgName" label={t("newOrgName")} hint={t("newOrgHint")} error={s.fields?.name} />}
            </div>
          )}
        </PeopleDialog>
      )}
      {open === "register" && (
        <PeopleDialog
          title={t("dialogs.register", { name: data.name })}
          action={withNotice(userRegisterAction, done("account_registered"))}
          submitLabel={t("actions.register")}
          onClose={close}
          hidden={hidden}
        >
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
        <PeopleDialog
          title={t("dialogs.account", { name: data.name })}
          action={withNotice(userAccountAction, done("account_updated"))}
          submitLabel={t("save")}
          onClose={close}
          hidden={hidden}
        >
          {(s) => (
            <div className="space-y-4">
              <TextField name="username" label={t("username")} defaultValue={acct.username} error={s.fields?.username} />
              <SelectField name="timezone" label={t("timezone")} placeholder={t("systemDefault")} defaultValue={acct.timezone} options={tzOptions} />
              <TextField name="passwd1" type="password" label={t("newPassword")} autoComplete="new-password" error={s.fields?.passwd1} />
              <TextField name="passwd2" type="password" label={t("confirmPassword")} autoComplete="new-password" error={s.fields?.passwd2} />
              <CheckField name="locked-flag" label={t("lockedFlag")} defaultChecked={!!(acct.status & UserAccountStatus.LOCKED)} />
              <CheckField name="pwreset-flag" label={t("requirePwReset")} defaultChecked={!!(acct.status & UserAccountStatus.REQUIRE_PASSWD_RESET)} />
              <CheckField name="forbid-pwchange-flag" label={t("forbidPwChange")} defaultChecked={!!(acct.status & UserAccountStatus.FORBID_PASSWD_RESET)} />
            </div>
          )}
        </PeopleDialog>
      )}
      {(open === "confirm" || open === "reset") && (
        <PeopleDialog
          title={t(`dialogs.${open}`, { name: data.name })}
          action={withNotice(userSendMailAction, done(open === "confirm" ? "confirm_sent" : "reset_sent"))}
          submitLabel={t("send")}
          onClose={close}
          hidden={{ ...hidden, kind: open }}
          notice={t(`${open}Notice`)}
        />
      )}
      {(open === "lock" || open === "unlock") && (
        <PeopleDialog
          title={t(`dialogs.${open}`, { name: data.name })}
          action={withNotice(userMassAction, done(open === "lock" ? "locked" : "unlocked"))}
          submitLabel={t(`actions.${open}`)}
          onClose={close}
          hidden={{ ids: data.userId, do: open }}
          notice={t(`${open}Notice`)}
        />
      )}
      {open === "delete" && (
        <PeopleDialog title={t("dialogs.delete", { name: data.name })} action={userDeleteAction} submitLabel={t("actions.delete")} onClose={close} hidden={hidden} danger notice={data.tickets ? t("deleteWithTickets", { n: data.tickets }) : t("deleteConfirm")}>
          {data.tickets > 0 && <CheckField name="deletetickets" label={t("deleteTickets")} />}
        </PeopleDialog>
      )}
    </>
  );
}
