"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import { orgAddUserAction, orgDeleteAction, orgProfileAction, orgRemoveUsersAction, orgUpdateAction } from "@/app/[locale]/(staff)/agent/(panel)/orgs/actions";
import ActionNotice from "@/components/common/ActionNotice";
import { useReadOnlyHint } from "@/components/common/WriteGate";
import Button from "@/components/ui/button/Button";
import { OrganizationModel } from "@/lib/osticket/flags";

import { CheckField, DynamicField, SelectField, TextField } from "../FormControls";
import PeopleDialog from "../PeopleDialog";
import type { Choice, DynField } from "../types";
import { useActionNotice } from "../useActionNotice";
import { ImportUsersButton, MassBar } from "./DirectoryButtons";

interface OrgActionsData {
  orgId: number;
  name: string;
  fields: DynField[];
  userFields: DynField[];
  profile: { domain: string; manager: string; status: number };
  managers: { agents: Choice[]; teams: Choice[] };
  members: { id: number; name: string; primary: boolean }[];
  users: Choice[];
  can: {
    edit: boolean;
    delete: boolean;
    addUser: boolean;
    createUser: boolean;
    import: boolean;
  };
}

type Kind = "edit" | "settings" | "addUser" | "delete";

/**
 * Azioni sulla scheda organizzazione (org-view.inc.php, ajax.orgs.php). Dopo un'azione riuscita la scheda
 * si ricarica e mostra l'esito; l'eliminazione torna alla lista, che mostra l'esito.
 */
export default function OrgActions({ data }: { data: OrgActionsData }) {
  const t = useTranslations("peopleDir");
  const tu = useTranslations("peopleUi");
  const [open, setOpen] = useState<Kind | null>(null);
  const [newUser, setNewUser] = useState(false);
  const close = useCallback(() => setOpen(null), []);
  const { notice, show, clear, withNotice } = useActionNotice();
  const done = (code: string) => () => tu(`done.${code}`);
  // sola lettura: pulsanti disattivati con il motivo nel tooltip
  const readOnly = useReadOnlyHint();
  const hidden = { orgId: data.orgId };
  const st = data.profile.status;
  const sharing = st & OrganizationModel.SHARE_EVERYBODY ? "sharing-all" : st & OrganizationModel.SHARE_PRIMARY_CONTACT ? "sharing-primary" : "";
  const buttons: { kind: Kind; show: boolean }[] = [
    { kind: "edit", show: data.can.edit },
    { kind: "settings", show: data.can.edit },
    { kind: "addUser", show: data.can.addUser },
    { kind: "delete", show: data.can.delete },
  ];

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
              {t(`orgActions.${b.kind}`)}
            </Button>
          ))}
        {data.can.import && <ImportUsersButton orgId={data.orgId} onDone={show} />}
        {notice && (
          <ActionNotice closeLabel={tu("dismiss")} onClose={clear}>
            {notice}
          </ActionNotice>
        )}
      </div>

      {open === "edit" && (
        <PeopleDialog
          title={t("dialogs.editOrg", { name: data.name })}
          action={withNotice(orgUpdateAction, done("org_updated"))}
          submitLabel={t("save")}
          onClose={close}
          hidden={hidden}
          notice={t("editOrgNotice")}
          wide
        >
          {(s) => (
            <div className="space-y-4">
              {data.fields.map((f) => (
                <DynamicField key={f.id} field={f} error={s.fields?.[f.name || String(f.id)]} />
              ))}
            </div>
          )}
        </PeopleDialog>
      )}
      {open === "settings" && (
        <PeopleDialog
          title={t("dialogs.settings", { name: data.name })}
          action={withNotice(orgProfileAction, done("org_settings"))}
          submitLabel={t("save")}
          onClose={close}
          hidden={{ ...hidden, name: data.name }}
          wide
        >
          {(s) => (
            <div className="space-y-4">
              <SelectField
                name="manager"
                label={t("accountManager")}
                placeholder={t("none")}
                defaultValue={data.profile.manager}
                options={[...data.managers.agents.map((a) => ({ id: `s${a.id}`, name: a.name })), ...data.managers.teams.map((a) => ({ id: `t${a.id}`, name: `${t("team")}: ${a.name}` }))]}
                error={s.fields?.manager}
              />
              <TextField name="domain" label={t("emailDomain")} defaultValue={data.profile.domain} hint={t("emailDomainHint")} error={s.fields?.domain} />
              <fieldset className="space-y-2">
                <legend className="mb-1 text-theme-sm font-medium text-gray-700 dark:text-gray-400">{t("ticketSharing")}</legend>
                {[
                  ["", t("sharingNone")],
                  ["sharing-primary", t("sharingPrimary")],
                  ["sharing-all", t("sharingAll")],
                ].map(([v, label]) => (
                  <label key={v} className="flex items-center gap-3 text-theme-sm text-gray-700 dark:text-gray-400">
                    <input type="radio" name="sharing" value={v} defaultChecked={sharing === v} className="size-4 border-gray-300 text-brand-500 dark:border-gray-700" />
                    {label}
                  </label>
                ))}
              </fieldset>
              <fieldset className="space-y-2">
                <legend className="mb-1 text-theme-sm font-medium text-gray-700 dark:text-gray-400">{t("autoCollab")}</legend>
                <CheckField name="collab-pc-flag" label={t("collabPrimary")} defaultChecked={!!(st & OrganizationModel.COLLAB_PRIMARY_CONTACT)} />
                <CheckField name="collab-all-flag" label={t("collabAll")} defaultChecked={!!(st & OrganizationModel.COLLAB_ALL_MEMBERS)} />
                <CheckField name="assign-am-flag" label={t("assignManager")} defaultChecked={!!(st & OrganizationModel.ASSIGN_AGENT_MANAGER)} />
              </fieldset>
              {data.members.length > 0 && (
                <fieldset className="space-y-2">
                  <legend className="mb-1 text-theme-sm font-medium text-gray-700 dark:text-gray-400">{t("primaryContacts")}</legend>
                  {data.members.map((m) => (
                    <CheckField key={m.id} name="contacts" value={String(m.id)} label={m.name} defaultChecked={m.primary} />
                  ))}
                </fieldset>
              )}
            </div>
          )}
        </PeopleDialog>
      )}
      {open === "addUser" && (
        <PeopleDialog
          title={t("dialogs.addUser", { name: data.name })}
          action={withNotice(orgAddUserAction, done("org_user_added"))}
          submitLabel={t("orgActions.addUser")}
          onClose={close}
          hidden={hidden}
          wide
        >
          {(s) => (
            <div className="space-y-4">
              {data.can.createUser && (
                <div className="flex gap-4 text-theme-sm">
                  <label className="flex items-center gap-2 text-gray-700 dark:text-gray-400">
                    <input type="radio" checked={!newUser} onChange={() => setNewUser(false)} className="size-4" /> {t("existingUser")}
                  </label>
                  <label className="flex items-center gap-2 text-gray-700 dark:text-gray-400">
                    <input type="radio" checked={newUser} onChange={() => setNewUser(true)} className="size-4" /> {t("newUser")}
                  </label>
                </div>
              )}
              {!newUser ? (
                <SelectField name="userId" label={t("user")} placeholder={t("selectUser")} options={data.users} error={s.fields?.id} />
              ) : (
                data.userFields.map((f) => <DynamicField key={f.id} field={f} error={s.fields?.[f.name || String(f.id)]} />)
              )}
            </div>
          )}
        </PeopleDialog>
      )}
      {open === "delete" && (
        <PeopleDialog
          title={t("dialogs.deleteOrg", { name: data.name })}
          action={orgDeleteAction}
          submitLabel={t("orgActions.delete")}
          onClose={close}
          hidden={hidden}
          danger
          notice={t("deleteOrgConfirm")}
        />
      )}
    </>
  );
}

/** Rimozione dei membri selezionati (scp/orgs.php a=remove-users). */
export function OrgMembersBar({ orgId, canRemove }: { orgId: number; canRemove: boolean }) {
  const t = useTranslations("peopleDir");
  const tu = useTranslations("peopleUi");
  return (
    <MassBar
      group="member"
      ops={
        canRemove
          ? [
              {
                key: "remove",
                label: t("removeUsers"),
                danger: true,
                done: (n) => tu("done.org_users_removed", { n }),
              },
            ]
          : []
      }
      action={orgRemoveUsersAction}
      hidden={{ orgId }}
    />
  );
}
