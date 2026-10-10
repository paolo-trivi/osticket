"use client";

import { useTranslations } from "next-intl";
import { useCallback, useId, useState, type ReactNode } from "react";

import { orgCreateAction, orgImportAction, orgMassDeleteAction } from "@/app/[locale]/(staff)/agent/(panel)/orgs/actions";
import { userCreateAction, userImportAction, userMassAction } from "@/app/[locale]/(staff)/agent/(panel)/users/actions";
import ActionNotice from "@/components/common/ActionNotice";
import { useReadOnlyHint } from "@/components/common/WriteGate";
import Button from "@/components/ui/button/Button";
import { checkedIds, useCheckedCount } from "@/lib/checked-ids";

import { CheckField, DynamicField, FormAlert, SelectField, TextAreaField } from "../FormControls";
import PeopleDialog from "../PeopleDialog";
import type { Choice, DynField, PeopleAction, PeopleActionState } from "../types";
import { useActionNotice } from "../useActionNotice";

/** Pulsante + dialogo con i campi del form dinamico (nuovo utente / nuova organizzazione). */
export function NewRecordButton({ kind, fields }: { kind: "user" | "org"; fields: DynField[] }) {
  const t = useTranslations("peopleDir");
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const readOnly = useReadOnlyHint();
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} disabled={!!readOnly} title={readOnly}>
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

/** Campo file stile TailAdmin (FileInput), coerente con gli altri controlli dei form. */
const fileInputClass =
  "h-11 w-full overflow-hidden rounded-lg border border-gray-300 bg-transparent text-sm text-gray-500 shadow-theme-xs transition-colors file:me-5 file:cursor-pointer file:rounded-s-lg file:border-0 file:border-e file:border-solid file:border-gray-200 file:bg-gray-50 file:py-3 file:ps-3.5 file:pe-3 file:text-sm file:text-gray-700 hover:file:bg-gray-100 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:file:border-gray-800 dark:file:bg-white/3 dark:file:text-gray-400";

/**
 * Messaggio d'errore dell'importazione: il dominio restituisce i testi del PHP (User::importCsv,
 * CsvImporter), tradotti qui riconoscendone la forma; un testo sconosciuto resta com'è.
 */
function useImportError() {
  const t = useTranslations("peopleUi.importErrors");
  return (detail: string): string => {
    let m: RegExpExecArray | null;
    if ((m = /^Bad data\. Expected: (.*)$/.exec(detail))) return t("badData", { fields: m[1] });
    if (detail === "Both `name` and `email` fields are required") return t("required");
    if (detail === "Whoops. Perhaps you meant to send some CSV records") return t("empty");
    if (detail === "Unable to parse submitted csv") return t("parse");
    if ((m = /^(.*): Unable to map header to the object field$/.exec(detail))) return t("header", { header: m[1] });
    if ((m = /^(.*): Field must have `variable` set to be imported$/.exec(detail))) return t("variable", { header: m[1] });
    if ((m = /^Unable to import user: (.*)$/s.exec(detail))) return t("user", { data: m[1] });
    return detail;
  };
}

/**
 * Import CSV di utenti (testo incollato o file), per la directory o un'organizzazione. L'esito
 * ("Successfully imported N end users") va a `onDone` se c'è, altrimenti è mostrato accanto al pulsante.
 */
export function ImportUsersButton({ orgId, onDone }: { orgId?: number; onDone?: (text: string) => void }) {
  const t = useTranslations("peopleDir");
  const tu = useTranslations("peopleUi");
  const importError = useImportError();
  const fileId = useId();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { notice, clear, withNotice } = useActionNotice();
  const readOnly = useReadOnlyHint();
  const text = (s: PeopleActionState) => tu("done.imported", { n: s.count ?? 0 });
  const action: PeopleAction = onDone
    ? async (prev, form) => {
        const s = await (orgId ? orgImportAction : userImportAction)(prev, form);
        if (s.ok) onDone(text(s));
        return s;
      }
    : withNotice(orgId ? orgImportAction : userImportAction, text);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={!!readOnly} title={readOnly}>
        {t("import")}
      </Button>
      {notice && (
        <ActionNotice closeLabel={tu("dismiss")} onClose={clear}>
          {notice}
        </ActionNotice>
      )}
      {open && (
        <PeopleDialog title={t("importTitle")} action={action} submitLabel={t("import")} onClose={close} hidden={orgId ? { orgId } : {}} notice={t("importHint")} wide>
          {(s) => (
            <div className="space-y-4">
              {s.fields?.pasted && <FormAlert kind="error">{importError(s.fields.pasted)}</FormAlert>}
              <TextAreaField name="pasted" label={t("importPaste")} rows={6} />
              <div className="space-y-1.5">
                <label htmlFor={fileId} className="block text-theme-sm font-medium text-gray-700 dark:text-gray-400">
                  {t("importFile")}
                </label>
                <input id={fileId} type="file" name="import" accept=".csv,text/csv" className={fileInputClass} />
              </div>
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
  /** esito se tutte le righe sono state elaborate (default: "Successfully managed selected …") */
  done?: (count: number) => string;
}

/**
 * Barra di azioni di massa sulle righe selezionate (gruppo `group`). Dopo l'azione mostra l'esito come
 * scp/users.php e scp/orgs.php: tutte elaborate o "Not all selected items were updated".
 */
export function MassBar({ group, ops, action, hidden }: { group: string; ops: MassOp[]; action: PeopleAction; hidden?: Record<string, string | number> }) {
  const t = useTranslations("peopleDir");
  const tu = useTranslations("peopleUi");
  const [op, setOp] = useState<MassOp | null>(null);
  const [ids, setIds] = useState<number[]>([]);
  const close = useCallback(() => setOp(null), []);
  const { notice, clear, withNotice } = useActionNotice();
  const doneText = (s: PeopleActionState) => {
    const n = s.count ?? 0;
    if (n < ids.length) return tu("done.mass_partial", { n, total: ids.length });
    return op?.done ? op.done(n) : tu("done.mass_done", { n });
  };
  const selector = `input[data-select="${group}"]`;
  const selected = useCheckedCount(selector);
  const readOnly = useReadOnlyHint();
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
            disabled={!selected || !!readOnly}
            title={readOnly}
            className={o.danger ? "text-error-600 dark:text-error-400" : ""}
            onClick={() => {
              setIds(checkedIds(selector));
              setOp(o);
            }}
          >
            {o.label}
          </Button>
        ))}
        {notice && (
          <ActionNotice closeLabel={tu("dismiss")} onClose={clear}>
            {notice}
          </ActionNotice>
        )}
      </div>
      {op && (
        <PeopleDialog
          title={op.label}
          action={withNotice(action, doneText)}
          submitLabel={op.label}
          onClose={close}
          hidden={{ ...hidden, do: op.key }}
          danger={op.danger}
          notice={[ids.length ? t("nSelected", { n: ids.length }) : t("noneSelected"), op.notice].filter(Boolean).join(" · ")}
        >
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
  return (
    <MassBar
      group="org"
      ops={
        canDelete
          ? [
              {
                key: "delete",
                label: t("mass.deleteOrgs"),
                danger: true,
                notice: t("deleteOrgConfirm"),
              },
            ]
          : []
      }
      action={orgMassDeleteAction}
    />
  );
}
