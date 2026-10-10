"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import {
  taskAssignAction,
  taskClaimAction,
  taskDeleteAction,
  taskDueDateAction,
  taskEditAction,
  taskStatusAction,
  taskTransferAction,
} from "@/app/[locale]/(staff)/agent/(panel)/tasks/actions";
import ActionNotice from "@/components/common/ActionNotice";
import { useReadOnlyHint } from "@/components/common/WriteGate";
import Button from "@/components/ui/button/Button";

import DueDateInput from "../DueDateInput";
import { DynamicField, SelectField } from "../FormControls";
import PeopleDialog from "../PeopleDialog";
import type { Choice, DynField } from "../types";
import { useActionNotice } from "../useActionNotice";

interface TaskActionsData {
  taskId: number;
  number: string;
  isOpen: boolean;
  assignedToMe: boolean;
  assignee: string | null;
  deptId: number;
  dueIso: string | null;
  can: {
    claim: boolean;
    assign: boolean;
    transfer: boolean;
    edit: boolean;
    delete: boolean;
    close: boolean;
    reopen: boolean;
  };
  closeBlocked: boolean;
  agents: Choice[];
  teams: Choice[];
  depts: Choice[];
  fields: DynField[];
}

type Kind = "claim" | "assignAgent" | "assignTeam" | "transfer" | "close" | "reopen" | "edit" | "due" | "delete";

/**
 * Barra azioni della vista task (task-view.tmpl.php): claim, assegnazione, trasferimento, stato, modifica,
 * eliminazione. Dopo un'azione riuscita la vista si ricarica e mostra l'esito (i messaggi di sessione di
 * ajax.tasks.php); l'eliminazione torna alla lista, che mostra l'esito.
 */
export default function TaskActionsBar({ data }: { data: TaskActionsData }) {
  const t = useTranslations("peopleTasks");
  const tu = useTranslations("peopleUi");
  const [open, setOpen] = useState<Kind | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const { notice, clear, withNotice } = useActionNotice();
  // sola lettura: pulsanti disattivati con il motivo nel tooltip
  const readOnly = useReadOnlyHint();
  const hidden = { taskId: data.taskId };
  const title = (k: string) => t(`dialogs.${k}`, { number: data.number });
  // Nome della scelta inviata (assegnatario "s<id>"/"t<id>", reparto) per il testo dell'esito
  const chosen = (form: FormData, key: string, list: Choice[], prefix = "") => list.find((c) => `${prefix}${c.id}` === String(form.get(key) ?? ""))?.name ?? "";
  const done = (code: string, values?: Record<string, string>) => () => tu(`done.${code}`, values);
  // task-view.tmpl.php: menu "Reassign"/"Assign" (Claim, Agent, Team) secondo che il task sia assegnato
  const assigned = !!data.assignee;

  const buttons: { kind: Kind; show: boolean; label: string }[] = [
    {
      kind: "claim",
      show: data.isOpen && data.can.claim && !data.assignedToMe,
      label: t("actions.claim"),
    },
    {
      kind: "assignAgent",
      show: data.isOpen && data.can.assign,
      label: t(assigned ? "actions.reassignAgent" : "actions.assignAgent"),
    },
    {
      kind: "assignTeam",
      show: data.isOpen && data.can.assign && data.teams.length > 0,
      label: t(assigned ? "actions.reassignTeam" : "actions.assignTeam"),
    },
    { kind: "transfer", show: data.can.transfer, label: t("actions.transfer") },
    { kind: "close", show: data.isOpen && data.can.close, label: t("actions.close") },
    { kind: "reopen", show: !data.isOpen && data.can.reopen, label: t("actions.reopen") },
    { kind: "edit", show: data.can.edit, label: t("actions.edit") },
    { kind: "due", show: data.isOpen && data.can.edit, label: t("actions.due") },
    { kind: "delete", show: data.can.delete, label: t("actions.delete") },
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
              {b.label}
            </Button>
          ))}
      </div>
      {notice && (
        <ActionNotice closeLabel={tu("dismiss")} onClose={clear}>
          {notice}
        </ActionNotice>
      )}

      {open === "claim" && (
        <PeopleDialog
          title={title("claim")}
          action={withNotice(taskClaimAction, done("task_claimed"))}
          submitLabel={t("actions.claim")}
          onClose={close}
          hidden={hidden}
          notice={data.assignee ? t("assignedTo", { name: data.assignee }) : t("confirmClaim")}
          commentsPlaceholder={t("commentsOptional")}
        />
      )}
      {open === "assignAgent" && (
        <PeopleDialog
          title={title(assigned ? "reassign" : "assign")}
          action={withNotice(taskAssignAction, (_s, f) =>
            tu("done.task_assigned", {
              name: chosen(f, "assignee", data.agents, "s"),
            }),
          )}
          submitLabel={t(assigned ? "actions.reassign" : "actions.assign")}
          onClose={close}
          hidden={hidden}
          notice={data.assignee ? t("assignedTo", { name: data.assignee }) : undefined}
          commentsPlaceholder={t("commentsOptional")}
        >
          {(s) => (
            <SelectField
              name="assignee"
              label={t("agent")}
              placeholder={t("selectAgent")}
              options={data.agents.map((a) => ({
                id: `s${a.id}`,
                name: a.name,
              }))}
              error={s.error === "unknown_assignee" ? "required" : undefined}
            />
          )}
        </PeopleDialog>
      )}
      {open === "assignTeam" && (
        <PeopleDialog
          title={title(assigned ? "reassign" : "assign")}
          action={withNotice(taskAssignAction, (_s, f) =>
            tu("done.task_assigned", {
              name: chosen(f, "assignee", data.teams, "t"),
            }),
          )}
          submitLabel={t(assigned ? "actions.reassign" : "actions.assign")}
          onClose={close}
          hidden={hidden}
          notice={data.assignee ? t("assignedTo", { name: data.assignee }) : undefined}
          commentsPlaceholder={t("commentsOptional")}
        >
          <SelectField name="assignee" label={t("team")} placeholder={t("selectTeam")} options={data.teams.map((a) => ({ id: `t${a.id}`, name: a.name }))} />
        </PeopleDialog>
      )}
      {open === "transfer" && (
        <PeopleDialog
          title={title("transfer")}
          action={withNotice(taskTransferAction, (_s, f) =>
            tu("done.task_transferred", {
              dept: chosen(f, "dept", data.depts),
            }),
          )}
          submitLabel={t("actions.transfer")}
          onClose={close}
          hidden={hidden}
          commentsPlaceholder={t("commentsOptional")}
        >
          <SelectField name="dept" label={t("department")} placeholder={t("selectDept")} defaultValue={data.deptId} options={data.depts} />
        </PeopleDialog>
      )}
      {(open === "close" || open === "reopen") && (
        <PeopleDialog
          title={title(open)}
          action={withNotice(taskStatusAction, done(open === "close" ? "task_closed" : "task_reopened"))}
          submitLabel={t(`actions.${open}`)}
          onClose={close}
          hidden={{ ...hidden, status: open === "close" ? "closed" : "open" }}
          notice={open === "close" && data.closeBlocked ? t("closeBlocked") : t("confirmStatus")}
          danger={open === "close" && data.closeBlocked}
          commentsPlaceholder={t("commentsOptional")}
        />
      )}
      {open === "edit" && (
        <PeopleDialog
          title={title("edit")}
          action={withNotice(taskEditAction, done("task_edited"))}
          submitLabel={t("save")}
          onClose={close}
          hidden={hidden}
          commentsPlaceholder={t("editNote")}
          commentsName="note"
          wide
        >
          {(s) => (
            <div className="space-y-4">
              {data.fields.map((f) => (
                <DynamicField key={f.id} field={{ ...f, name: `f:${f.name || f.id}` }} error={s.fields?.[f.name || String(f.id)]} />
              ))}
            </div>
          )}
        </PeopleDialog>
      )}
      {open === "due" && (
        <PeopleDialog
          title={title("due")}
          action={withNotice(taskDueDateAction, done("task_due"))}
          submitLabel={t("save")}
          onClose={close}
          hidden={hidden}
          commentsPlaceholder={t("commentsOptional")}
        >
          {(s) => (
            <DueDateInput name="due" label={t("dueDate")} defaultIso={data.dueIso} error={s.error === "due_past" ? "due_past" : s.error === "invalid_date" ? "invalid_date" : undefined} />
          )}
        </PeopleDialog>
      )}
      {open === "delete" && (
        <PeopleDialog title={title("delete")} action={taskDeleteAction} submitLabel={t("actions.delete")} onClose={close} hidden={hidden} notice={t("confirmDelete")} danger commentsPlaceholder={t("deleteReason")} />
      )}
    </>
  );
}
