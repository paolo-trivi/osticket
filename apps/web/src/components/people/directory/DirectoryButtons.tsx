"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState, type ReactNode } from "react";

import { orgCreateAction, orgImportAction, orgMassDeleteAction } from "@/app/[locale]/(staff)/agent/(panel)/orgs/actions";
import { userCreateAction, userImportAction, userMassAction } from "@/app/[locale]/(staff)/agent/(panel)/users/actions";
import Button from "@/components/ui/button/Button";
import { checkedIds } from "@/lib/checked-ids";

import { CheckField, DynamicField, FormAlert, SelectField, TextAreaField } from "../FormControls";
import PeopleDialog from "../PeopleDialog";
import type { Choice, DynField, PeopleAction } from "../types";

/** Pulsante + dialogo con i campi del form dinamico (nuovo utente / nuova organizzazione). */
export function NewRecordButton({ kind, fields }: { kind: "user" | "org"; fields: DynField[] }) {
  const t = useTranslations("peopleDir");
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        {t(kind === "user" ? "newUser" : "newOrg")}
      </Button>
      {open && (
        <PeopleDialog title={t(kind === "user" ? "newUser" : "newOrg")} action={kind === "user" ? userCreateAction : orgCreateAction} submitLabel={t("create")} onClose={close} wide>
          {(s) => (
            <div className="space-y-4">
              {fields.map((f) => (
                <DynamicField key={f.id} field={f} error={s.fields?.[f.name || String(f.id)]} />
              ))}
            </div>
          )}
        </PeopleDialog>
      )}
    </>
  );
}

/** Import CSV di utenti (testo incollato o file), per la directory o un'organizzazione. */
export function ImportUsersButton({ orgId }: { orgId?: number }) {
  const t = useTranslations("peopleDir");
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {t("import")}
      </Button>
      {open && (
        <PeopleDialog title={t("importTitle")} action={orgId ? orgImportAction : userImportAction} submitLabel={t("import")} onClose={close} hidden={orgId ? { orgId } : {}} notice={t("importHint")} wide>
          {(s) => (
            <div className="space-y-4">
              {s.fields?.pasted && <FormAlert kind="error">{s.fields.pasted}</FormAlert>}
              <TextAreaField name="pasted" label={t("importPaste")} rows={6} />
              <label className="block space-y-1.5">
                <span className="text-theme-sm font-medium text-gray-700 dark:text-gray-400">{t("importFile")}</span>
                <input type="file" name="import" accept=".csv,text/csv" className="block w-full text-sm text-gray-700 dark:text-gray-400" />
              </label>
            </div>
          )}
        </PeopleDialog>
      )}
    </>
  );
}

/** Casella di selezione di una riga (utenti, organizzazioni, membri). */
export function RowSelect({ id, group }: { id: number; group: string }) {
  return <input type="checkbox" data-select={group} value={id} className="size-4 rounded border-gray-300 text-brand-500 dark:border-gray-700 dark:bg-gray-900" aria-label={`#${id}`} />;
}

interface MassOp {
  key: string;
  label: string;
  danger?: boolean;
  body?: ReactNode;
  notice?: string;
}

/** Barra di azioni di massa sulle righe selezionate (gruppo `group`). */
export function MassBar({ group, ops, action, hidden }: { group: string; ops: MassOp[]; action: PeopleAction; hidden?: Record<string, string | number> }) {
  const t = useTranslations("peopleDir");
  const [op, setOp] = useState<MassOp | null>(null);
  const [ids, setIds] = useState<number[]>([]);
  const close = useCallback(() => setOp(null), []);
  if (!ops.length) return null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-theme-sm text-gray-500 dark:text-gray-400">{t("selected")}</span>
        {ops.map((o) => (
          <Button
            key={o.key}
            size="sm"
            variant="outline"
            className={o.danger ? "text-error-600 dark:text-error-400" : ""}
            onClick={() => {
              setIds(checkedIds(`input[data-select="${group}"]`));
              setOp(o);
            }}
          >
            {o.label}
          </Button>
        ))}
      </div>
      {op && (
        <PeopleDialog title={op.label} action={action} submitLabel={op.label} onClose={close} hidden={{ ...hidden, do: op.key }} danger={op.danger} notice={[ids.length ? t("nSelected", { n: ids.length }) : t("noneSelected"), op.notice].filter(Boolean).join(" · ")}>
          {ids.map((id) => (
            <input key={id} type="hidden" name="ids" value={id} />
          ))}
          {op.body}
        </PeopleDialog>
      )}
    </>
  );
}

/** Azioni di massa della directory utenti (scp/users.php mass_process). */
export function UserMassBar({ can, orgs }: { can: { manage: boolean; delete: boolean; edit: boolean }; orgs: Choice[] }) {
  const t = useTranslations("peopleDir");
  const ops: MassOp[] = [];
  if (can.manage) {
    ops.push({ key: "register", label: t("mass.register") }, { key: "reset", label: t("mass.reset") }, { key: "lock", label: t("mass.lock") }, { key: "unlock", label: t("mass.unlock") });
  }
  if (can.edit) ops.push({ key: "setorg", label: t("mass.setorg"), body: <SelectField name="orgId" label={t("organization")} placeholder={t("selectOrg")} options={orgs} /> });
  if (can.delete) ops.push({ key: "delete", label: t("mass.delete"), danger: true, notice: t("deleteConfirm"), body: <CheckField name="deletetickets" label={t("deleteTickets")} /> });
  return <MassBar group="user" ops={ops} action={userMassAction} />;
}

/** Eliminazione di massa delle organizzazioni (scp/orgs.php mass_process). */
export function OrgMassBar({ canDelete }: { canDelete: boolean }) {
  const t = useTranslations("peopleDir");
  return <MassBar group="org" ops={canDelete ? [{ key: "delete", label: t("mass.deleteOrgs"), danger: true, notice: t("deleteOrgConfirm") }] : []} action={orgMassDeleteAction} />;
}
